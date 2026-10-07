/**
 * Cloud Run Deploy Service
 * Loads a base YAML template, applies overrides, validates, and deploys to Google Cloud Run.
 * Before deploying, creates a GCS folder via bucket-manager and mounts it into the container.
 */

const fs = require("node:fs");
const yaml = require("js-yaml");
const { ServicesClient } = require("@google-cloud/run");
const config = require("../config");
const {
  BadRequestError,
  ValidationError,
  InternalError,
  ApiError,
} = require("../utils/errors");

/**
 * Normalise the `folders` field from the deploy request into a plain string array.
 * Accepts:
 *   - undefined / null  → []
 *   - "agents/main"     → ["agents/main"]
 *   - ["agents/main", "agents/cron"] → ["agents/main", "agents/cron"]
 *   - [{ path: "agents/main" }, ...]  → ["agents/main", ...]
 * Strips empty strings and leading/trailing slashes.
 * @param {*} raw
 * @returns {string[]}
 */
function normaliseFolders(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map((f) => (typeof f === "object" && f !== null ? f.path ?? "" : String(f ?? "")))
    .map((f) => f.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
}

/**
 * Create one or more folders in GCS via bucket-manager.
 * Throws an ApiError (502) if any folder fails to be created, listing every failure.
 * @param {string[]} folders - Array of folder paths (e.g. ["agents/main", "agents/cron"])
 * @returns {Promise<string[]>} Successfully created folder paths.
 */
async function createAgentFolders(folders) {
  const { url, bucket } = config.bucketManager;
  if (!bucket) {
    throw new ApiError(
      "BUCKET_MANAGER_BUCKET is not configured. Cannot create GCS folders.",
      502,
      "BUCKET_MANAGER_NOT_CONFIGURED",
      "Set the BUCKET_MANAGER_BUCKET environment variable on the cloud-run-deployer."
    );
  }
  if (!folders.length) return [];

  const endpoint = `${url.replace(/\/+$/, "")}/api/v1/buckets/${encodeURIComponent(bucket)}/folders`;
  const created = [];
  const failed = [];

  const { apiSecret } = config.bucketManager;
  const authHeaders = apiSecret ? { "X-Bucket-Manager-Secret": apiSecret } : {};

  await Promise.all(
    folders.map(async (folderPath) => {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({ path: folderPath }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          const reason = body?.error ?? body?.message ?? `HTTP ${res.status}`;
          console.error(`[bucket-manager] Folder "${folderPath}" failed (${res.status}): ${reason}`);
          failed.push({ path: folderPath, status: res.status, reason });
        } else {
          console.log(`[bucket-manager] Folder created: gs://${bucket}/${folderPath}/`);
          created.push(folderPath);
        }
      } catch (err) {
        console.error(`[bucket-manager] Network error creating folder "${folderPath}": ${err.message}`);
        failed.push({ path: folderPath, status: null, reason: err.message });
      }
    })
  );

  if (failed.length > 0) {
    const summary = failed.map((f) => `"${f.path}" (${f.reason})`).join(", ");
    throw new ApiError(
      `Failed to create ${failed.length} of ${folders.length} GCS folder(s): ${summary}`,
      502,
      "FOLDER_CREATION_FAILED",
      "Check that bucket-manager is running, BUCKET_MANAGER_URL is correct, and the service account has storage.objects.create permission."
    );
  }

  return created;
}

/**
 * Inject one GCS volume + volumeMount per folder into the service spec.
 * Each folder gets its own named volume so Cloud Run can mount them independently.
 *
 * Example for folders ["agents/main", "agents/cron"] with baseMountPath "/home/node/.openclaw":
 *   volumes:
 *     - name: gcs-vol-0   gcs: { bucket, mountOptions: ["only-dir=agents/main"] }
 *     - name: gcs-vol-1   gcs: { bucket, mountOptions: ["only-dir=agents/cron"] }
 *   volumeMounts:
 *     - name: gcs-vol-0   mountPath: /home/node/.openclaw
 *     - name: gcs-vol-1   mountPath: /home/node/.openclaw/agents/cron
 *
 * The first folder is always mounted at baseMountPath; subsequent folders are mounted
 * at baseMountPath/<folderPath> so they don't collide.
 *
 * @param {Object} serviceSpec - Merged service spec (mutated in place)
 * @param {string} bucketName  - GCS bucket name
 * @param {string[]} folders   - Array of GCS object prefixes
 */
function injectGCSVolumeMounts(serviceSpec, bucketName, folders) {
  if (!folders.length) return;

  const baseMountPath = config.bucketManager.mountPath;
  const template = serviceSpec.template;
  if (!template) return;

  if (!Array.isArray(template.volumes)) template.volumes = [];
  const container = template.containers?.[0];
  if (!container) return;
  if (!Array.isArray(container.volumeMounts)) container.volumeMounts = [];

  // Remove any previously injected gcs-vol-* entries to avoid duplicates on update
  template.volumes = template.volumes.filter((v) => !/^gcs-vol-/.test(v.name));
  container.volumeMounts = container.volumeMounts.filter((m) => !/^gcs-vol-/.test(m.name));

  folders.forEach((folderPath, idx) => {
    const volumeName = `gcs-vol-${idx}`;
    // First folder → baseMountPath; rest → baseMountPath/<folderPath>
    const mountPath = idx === 0 ? baseMountPath : `${baseMountPath}/${folderPath}`;

    template.volumes.push({
      name: volumeName,
      gcs: {
        bucket: bucketName,
        mountOptions: [`only-dir=${folderPath}`],
      },
    });

    container.volumeMounts.push({
      name: volumeName,
      mountPath,
    });
  });
}

const VALID_CPUS = ["1", "2", "4", "8"];
const MEMORY_PATTERN = /^\d+(Mi|Gi)$/;

/**
 * Parse a duration string (e.g. "300s", "60") into protobuf Duration { seconds, nanos }.
 * Cloud Run gRPC client expects Duration as object, not string.
 */
function parseTimeoutToDuration(value) {
  if (value == null) return undefined;
  if (typeof value === "object" && "seconds" in value) return value;
  const str = String(value).trim().replace(/(\d+)$/, "$1s");
  const match = str.match(/^(\d+)(?:\.(\d+))?s$/);
  const seconds = match ? parseInt(match[1], 10) : parseInt(str, 10) || 300;
  const nanos = match?.[2] ? parseInt(match[2].padEnd(9, "0").slice(0, 9), 10) : 0;
  return { seconds: Math.max(0, seconds), nanos };
}

/**
 * Convert service spec to the shape expected by Cloud Run gRPC client (e.g. timeout as Duration object).
 */
function toApiShape(serviceSpec) {
  const spec = structuredClone(serviceSpec);
  const template = spec.template;
  if (template?.timeout != null) {
    template.timeout = parseTimeoutToDuration(template.timeout);
  }
  return spec;
}

/**
 * Load and parse the base Cloud Run YAML template.
 * @returns {Object} Parsed service spec (template body for Cloud Run API)
 */
function loadBaseTemplate() {
  const templatePath = config.cloudRun?.templatePath;
  if (!templatePath || !templatePath.trim()) {
    throw new InternalError("Cloud Run template path is not configured. Set CLOUD_RUN_TEMPLATE_PATH.");
  }
  let raw;
  try {
    raw = fs.readFileSync(templatePath, "utf8");
  } catch (err) {
    throw new InternalError(
      `Failed to load Cloud Run template: ${err.message}`
    );
  }
  try {
    return yaml.load(raw);
  } catch (err) {
    throw new InternalError(
      `Invalid Cloud Run template YAML: ${err.message}`
    );
  }
}

/**
 * Apply configurable overrides onto the base template.
 * @param {Object} base - Parsed base YAML
 * @param {Object} overrides - { serviceName, containerImage, region, env, resources, minInstances, maxInstances, timeout }
 * @returns {Object} Merged service spec
 */
function applyOverrides(base, overrides) {
  const merged = structuredClone(base);

  if (!merged.template) merged.template = {};
  if (!merged.template.containers?.length) {
    merged.template.containers = [{ image: "", env: [], resources: { limits: {} } }];
  }
  const container = merged.template.containers[0];

  const image =
    overrides.containerImage ||
    (overrides.containerImage === "" ? "" : null) ||
    (container.image && container.image !== "{{CONTAINER_IMAGE}}"
      ? container.image
      : null);
  if (image !== null) {
    container.image = image;
  } else if (String(container.image) === "{{CONTAINER_IMAGE}}") {
    container.image = "gcr.io/cloudrun/container:hello"; // fallback only if template had placeholder
  }

  if (Array.isArray(overrides.env) && overrides.env.length > 0) {
    container.env = overrides.env.map((e) =>
      typeof e === "string"
        ? { name: e.split("=")[0], value: e.split("=").slice(1).join("=") || "" }
        : { name: e.name, value: String(e.value ?? "") }
    );
  }

  if (overrides.resources) {
    container.resources = container.resources || { limits: {} };
    container.resources.limits = container.resources.limits || {};
    if (overrides.resources.cpu != null)
      container.resources.limits.cpu = String(overrides.resources.cpu);
    if (overrides.resources.memory != null)
      container.resources.limits.memory = String(overrides.resources.memory);
    if (overrides.resources.cpuIdle !== undefined)
      container.resources.cpuIdle = Boolean(overrides.resources.cpuIdle);
  }

  if (overrides.minInstances !== undefined || overrides.maxInstances !== undefined) {
    merged.template.scaling = merged.template.scaling || {};
    if (overrides.minInstances !== undefined)
      merged.template.scaling.minInstanceCount = Number(overrides.minInstances);
    if (overrides.maxInstances !== undefined)
      merged.template.scaling.maxInstanceCount = Number(overrides.maxInstances);
  }

  // Per-instance request concurrency. Cloud Run defaults to 80 which is too
  // high for long-running LLM chat workloads where each request can hold a
  // worker for minutes; competing requests starve the event loop and tail
  // latency explodes. Setting this lower (e.g. 8) keeps tenants responsive.
  // Field name on the Cloud Run v2 API is `maxInstanceRequestConcurrency`.
  if (overrides.concurrency !== undefined && overrides.concurrency !== null) {
    merged.template.maxInstanceRequestConcurrency = Number(overrides.concurrency);
  }

  if (overrides.timeout != null) {
    merged.template.timeout =
      String(overrides.timeout).replace(/(\d+)$/, "$1s") || "300s";
  }

  if (overrides.description != null) {
    merged.description = String(overrides.description);
  }

  // VPC: preserve template.vpcAccess from base (Direct VPC egress). Cloud Run API v2 uses vpcAccess, not annotations.
  if (overrides.vpcAccess !== undefined) {
    merged.template.vpcAccess = overrides.vpcAccess;
  }
  // else: base template vpcAccess (from YAML) is already in merged via structuredClone

  // GCS volume mounts — required for per-tenant state directory
  if (Array.isArray(overrides.volumes) && overrides.volumes.length > 0) {
    merged.template.volumes = overrides.volumes;
  } else if (Array.isArray(merged.template.volumes) && merged.template.volumes.length === 0) {
    // Remove empty placeholder so Cloud Run API doesn't reject empty volumes array
    delete merged.template.volumes;
  }
  if (Array.isArray(overrides.volumeMounts) && overrides.volumeMounts.length > 0) {
    container.volumeMounts = overrides.volumeMounts;
  } else if (Array.isArray(container.volumeMounts) && container.volumeMounts.length === 0) {
    delete container.volumeMounts;
  }

  // Execution environment override (e.g. EXECUTION_ENVIRONMENT_GEN2 needed for GCS volumes)
  if (overrides.executionEnvironment !== undefined) {
    merged.template.executionEnvironment = overrides.executionEnvironment;
  }

  // Handle public access - set at service level metadata (not template)
  // Default: public access is enabled
  // Can be overridden with publicAccess: false to require authentication
  if (!merged.metadata) merged.metadata = {};
  if (!merged.metadata.annotations) merged.metadata.annotations = {};
  
  if (overrides.publicAccess === false) {
    // Explicitly disable public access - remove annotation to require authentication
    delete merged.metadata.annotations["run.googleapis.com/invoker-iam-disabled"];
    // Also try setting invokerIamDisabled field if API supports it
    merged.invokerIamDisabled = false;
  } else {
    // Default: always allow public access
    merged.metadata.annotations["run.googleapis.com/invoker-iam-disabled"] = "true";
    // Also try setting invokerIamDisabled field if API supports it
    merged.invokerIamDisabled = true;
  }

  return merged;
}

/**
 * Validate the merged Cloud Run service spec.
 * @param {Object} serviceSpec - Merged service body
 * @param {string} serviceId - Service ID (name)
 * @param {string} projectId - GCP project ID
 * @param {string} region - GCP region
 */
function validateConfig(serviceSpec, serviceId, projectId, region) {
  const errors = [];

  if (!serviceId || typeof serviceId !== "string") {
    errors.push({ field: "serviceName", message: "Service name is required" });
  } else if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(serviceId)) {
    errors.push({
      field: "serviceName",
      message:
        "Service name must be DNS label (lowercase, numbers, hyphens, max 63 chars)",
    });
  }

  if (!projectId || !projectId.trim()) {
    errors.push({ field: "projectId", message: "GCP project ID is required" });
  }

  if (!region || !region.trim()) {
    errors.push({ field: "region", message: "Region is required" });
  }

  const container =
    serviceSpec.template &&
    serviceSpec.template.containers &&
    serviceSpec.template.containers[0];
  if (!container) {
    errors.push({ field: "template", message: "At least one container is required" });
  } else {
    if (!container.image || !container.image.trim()) {
      errors.push({ field: "containerImage", message: "Container image is required" });
    }
    const limits = container.resources && container.resources.limits;
    if (limits) {
      if (limits.cpu && !VALID_CPUS.includes(String(limits.cpu))) {
        errors.push({
          field: "resources.cpu",
          message: `CPU must be one of: ${VALID_CPUS.join(", ")}`,
        });
      }
      if (
        limits.memory &&
        !MEMORY_PATTERN.test(String(limits.memory))
      ) {
        errors.push({
          field: "resources.memory",
          message: "Memory must be e.g. 256Mi, 512Mi, 1Gi, 2Gi",
        });
      }
    }
  }

  const scaling = serviceSpec.template && serviceSpec.template.scaling;
  if (scaling) {
    const min = scaling.minInstanceCount;
    const max = scaling.maxInstanceCount;
    if (min != null && (min < 0 || !Number.isInteger(min))) {
      errors.push({
        field: "minInstances",
        message: "minInstanceCount must be a non-negative integer",
      });
    }
    if (max != null && (max < 0 || !Number.isInteger(max))) {
      errors.push({
        field: "maxInstances",
        message: "maxInstanceCount must be a non-negative integer",
      });
    }
    if (
      min != null &&
      max != null &&
      Number.isInteger(min) &&
      Number.isInteger(max) &&
      min > max
    ) {
      errors.push({
        field: "scaling",
        message: "minInstanceCount cannot exceed maxInstanceCount",
      });
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(errors);
  }
}

/**
 * Deploy the service to Google Cloud Run (create or replace).
 * @param {Object} options
 * @param {string}   options.serviceName     - DNS-safe service name (required)
 * @param {string}   options.containerImage  - Container image URL (required)
 * @param {string}   [options.region]        - GCP region
 * @param {string}   [options.projectId]     - GCP project ID
 * @param {Array}    [options.env]           - Env vars as [{ name, value }] or ["KEY=value"]
 * @param {Object}   [options.resources]     - { cpu, memory, cpuIdle }
 * @param {number}   [options.minInstances]
 * @param {number}   [options.maxInstances]
 * @param {string}   [options.timeout]       - e.g. "300s"
 * @param {string}   [options.description]
 * @param {boolean}  [options.publicAccess]
 * @param {string|string[]|Array<{path:string}>} [options.folders]
 *   GCS folders to create (via bucket-manager) and mount into the container.
 *   Examples:
 *     "agents/main"
 *     ["agents/main", "agents/cron"]
 *     [{ path: "agents/main" }, { path: "agents/cron" }]
 *   If omitted, no GCS volume is mounted.
 * @returns {Promise<{ status, serviceUrl, reconciling?, serviceName, region, latestReadyRevision?, folders }>}
 */
async function deploy(options = {}) {
  const projectId =
    options.projectId ?? config.cloudRun?.projectId ?? process.env.GCP_PROJECT_ID;
  const region =
    options.region ?? config.cloudRun?.region ?? process.env.GCP_REGION ?? "europe-west1";
  const serviceId = options.serviceName || options.serviceId;

  if (!projectId || !projectId.trim()) {
    throw new BadRequestError(
      "GCP project ID is required. Set GCP_PROJECT_ID or pass projectId in the request body."
    );
  }

  let base = loadBaseTemplate();
  const serviceSpec = applyOverrides(base, {
    ...options,
    region,
    projectId,
  });

  validateConfig(serviceSpec, serviceId, projectId, region);

  // Create requested GCS folders via bucket-manager, then mount them into the container.
  const { bucket: bucketName } = config.bucketManager;
  const requestedFolders = normaliseFolders(options.folders);
  const createdFolders = await createAgentFolders(requestedFolders);
  if (createdFolders.length && bucketName) {
    injectGCSVolumeMounts(serviceSpec, bucketName, createdFolders);
  }

  const parent = `projects/${projectId}/locations/${region}`;
  const runClient = new ServicesClient();
  const apiSpec = toApiShape(serviceSpec);

  let service;
  try {
    const [operation] = await runClient.createService({
      parent,
      serviceId,
      service: apiSpec,
      validateOnly: false,
    });
    const [response] = await operation.promise();
    service = response;
  } catch (err) {
    if (err.code === 6 || (err.message && err.message.includes("already exists"))) {
      // ALREADY_EXISTS: update (patch) existing service
      const fullServiceName = `${parent}/services/${serviceId}`;
      const serviceForUpdate = { ...apiSpec, name: fullServiceName };
      const [operation] = await runClient.updateService({
        service: serviceForUpdate,
        validateOnly: false,
      });
      const [response] = await operation.promise();
      service = response;
    } else if (
      err.message?.includes("Could not load the default credentials") ||
      err.message?.includes("credentials") ||
      err.message?.includes("authentication")
    ) {
      throw new ApiError(
        "Google Cloud credentials are not configured. Set up Application Default Credentials to deploy to Cloud Run.",
        503,
        "GCP_CREDENTIALS_MISSING",
        "Run 'gcloud auth application-default login' or set GOOGLE_APPLICATION_CREDENTIALS to a service account key file. See https://cloud.google.com/docs/authentication/getting-started"
      );
    } else {
      throw new InternalError(
        `Cloud Run deployment failed: ${err.message}`
      );
    }
  }

  const serviceUrl = service.uri ?? service.url ?? "";
  const reconciling = Boolean(service.reconciling);

  return {
    status: reconciling ? "RECONCILING" : "READY",
    serviceUrl,
    reconciling,
    serviceName: serviceId,
    region,
    latestReadyRevision: service.latestReadyRevision ?? null,
    folders: createdFolders,
  };
}

/**
 * Delete a Cloud Run service.
 * @param {string} serviceName - Service ID (DNS label)
 * @param {Object} options - { projectId?, region? }
 * @returns {Promise<{ deleted: boolean, serviceName: string, region: string }>}
 */
async function deleteService(serviceName, options = {}) {
  const projectId =
    options.projectId ?? config.cloudRun?.projectId ?? process.env.GCP_PROJECT_ID;
  const region =
    options.region ?? config.cloudRun?.region ?? process.env.GCP_REGION ?? "europe-west1";

  if (!serviceName || typeof serviceName !== "string" || !serviceName.trim()) {
    throw new BadRequestError("Service name is required.");
  }
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(serviceName)) {
    throw new BadRequestError(
      "Service name must be a DNS label (lowercase, numbers, hyphens, max 63 chars)."
    );
  }
  if (!projectId || !projectId.trim()) {
    throw new BadRequestError(
      "GCP project ID is required. Set GCP_PROJECT_ID or pass projectId in the request."
    );
  }

  const name = `projects/${projectId}/locations/${region}/services/${serviceName}`;
  const runClient = new ServicesClient();

  try {
    const [operation] = await runClient.deleteService({ name });
    await operation.promise();
    return { deleted: true, serviceName, region };
  } catch (err) {
    if (err.code === 5 || (err.message && err.message.includes("not found"))) {
      throw new ApiError(
        `Cloud Run service '${serviceName}' not found in ${region}.`,
        404,
        "NOT_FOUND",
        "Check the service name and region."
      );
    }
    if (
      err.message?.includes("Could not load the default credentials") ||
      err.message?.includes("credentials") ||
      err.message?.includes("authentication")
    ) {
      throw new ApiError(
        "Google Cloud credentials are not configured. Set up Application Default Credentials to delete Cloud Run services.",
        503,
        "GCP_CREDENTIALS_MISSING",
        "Run 'gcloud auth application-default login' or set GOOGLE_APPLICATION_CREDENTIALS to a service account key file. See https://cloud.google.com/docs/authentication/getting-started"
      );
    }
    throw new InternalError(`Cloud Run delete failed: ${err.message}`);
  }
}

/**
 * Restart a Cloud Run service by updating its metadata annotations to force
 * creation of a new revision. This does not change the image or config; it
 * simply triggers Cloud Run to roll instances.
 *
 * @param {string} serviceName - Service ID (DNS label)
 * @param {Object} options - { projectId?, region? }
 * @returns {Promise<{ restarted: boolean, serviceName: string, region: string, latestReadyRevision: string | null }>}
 */
async function restartService(serviceName, options = {}) {
  const projectId =
    options.projectId ?? config.cloudRun?.projectId ?? process.env.GCP_PROJECT_ID;
  const region =
    options.region ?? config.cloudRun?.region ?? process.env.GCP_REGION ?? "europe-west1";

  if (!serviceName || typeof serviceName !== "string" || !serviceName.trim()) {
    throw new BadRequestError("Service name is required.");
  }
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(serviceName)) {
    throw new BadRequestError(
      "Service name must be a DNS label (lowercase, numbers, hyphens, max 63 chars)."
    );
  }
  if (!projectId || !projectId.trim()) {
    throw new BadRequestError(
      "GCP project ID is required. Set GCP_PROJECT_ID or pass projectId in the request."
    );
  }

  const name = `projects/${projectId}/locations/${region}/services/${serviceName}`;
  const runClient = new ServicesClient();

  try {
    const [service] = await runClient.getService({ name });

    // Force a new revision by updating the *container spec* (env var).
    // Cloud Run always creates a new revision when the container config changes.
    service.template = service.template || {};
    service.template.containers = service.template.containers || [];
    if (!service.template.containers[0]) {
      service.template.containers[0] = {};
    }
    const container = service.template.containers[0];
    container.env = Array.isArray(container.env) ? container.env.slice() : [];

    const now = new Date().toISOString();
    const existingIdx = container.env.findIndex((e) => e && e.name === "RESTART_TRIGGER_AT");
    if (existingIdx >= 0) {
      container.env[existingIdx] = { ...container.env[existingIdx], value: now };
    } else {
      container.env.push({ name: "RESTART_TRIGGER_AT", value: now });
    }

    const [operation] = await runClient.updateService({
      service,
      validateOnly: false,
    });
    const [response] = await operation.promise();

    return {
      restarted: true,
      serviceName,
      region,
      latestReadyRevision: response.latestReadyRevision ?? null,
    };
  } catch (err) {
    if (err.code === 5 || (err.message && err.message.includes("not found"))) {
      throw new ApiError(
        `Cloud Run service '${serviceName}' not found in ${region}.`,
        404,
        "NOT_FOUND",
        "Check the service name and region."
      );
    }
    if (
      err.message?.includes("Could not load the default credentials") ||
      err.message?.includes("credentials") ||
      err.message?.includes("authentication")
    ) {
      throw new ApiError(
        "Google Cloud credentials are not configured. Set up Application Default Credentials to manage Cloud Run services.",
        503,
        "GCP_CREDENTIALS_MISSING",
        "Run 'gcloud auth application-default login' or set GOOGLE_APPLICATION_CREDENTIALS to a service account key file. See https://cloud.google.com/docs/authentication/getting-started"
      );
    }
    throw new InternalError(`Cloud Run restart failed: ${err.message}`);
  }
}

module.exports = {
  loadBaseTemplate,
  applyOverrides,
  validateConfig,
  deploy,
  deleteService,
  restartService,
};
