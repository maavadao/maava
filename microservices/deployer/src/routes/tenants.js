/**
 * Tenant provisioning routes — deploy a per-user Cloud Run backend.
 *
 * POST /api/v1/tenants/provision
 *   Body: { subdomain, userId, tenantId, gatewayToken }
 *   Creates a Cloud Run service with GCS bucket mounting, JWT auth, and DB connection.
 *
 * DELETE /api/v1/tenants/:subdomain
 *   Deletes the Cloud Run service for a tenant.
 */

const { Router } = require("express");
const crypto = require("crypto");
const { asyncHandler } = require("../middleware/errorHandler");
const { created, success } = require("../utils/response");
const CloudRunDeployService = require("../services/CloudRunDeployService");
const { Storage } = require("@google-cloud/storage");
const config = require("../config");

/** The member space (mawadao-agent-dashboard) that talks to every tenant's runtime. */
const MEMBER_SPACE_URL = (process.env.MEMBER_SPACE_URL || "https://agent.mawadao.com").replace(/\/+$/, "");

/** mawadao-agent-storage service URL and secret for creating GCS folders + seeding openclaw.json */
const STORAGE_URL = process.env.STORAGE_URL || "";
const STORAGE_API_SECRET = process.env.STORAGE_API_SECRET || "";

/**
 * GCP project ID for GCS bucket creation — may differ from the Cloud Run project.
 * e.g. Cloud Run lives in "mawadao" but tenant buckets are in "mawadao-customer-side".
 */
const GCS_PROJECT_ID = process.env.GCS_PROJECT_ID || process.env.GCP_PROJECT_ID || "mawadao";

function sanitizeSecret(value) {
  return String(value || "").replace(/^\uFEFF+/, "").trim();
}

/**
 * Parse service-account credentials for GCS operations.
 * Checks two env vars (in order):
 *   1. GOOGLE_CREDENTIALS_JSON_B64 — base64url-encoded JSON (no special chars, safe in env)
 *   2. GOOGLE_CREDENTIALS_JSON     — raw JSON string (fallback)
 * Falls back to Application Default Credentials (Workload Identity) when neither is set.
 */
function getGCSCredentials() {
  // Prefer base64url-encoded form — avoids quoting/escaping issues in gcloud env vars
  const b64 = process.env.GOOGLE_CREDENTIALS_JSON_B64;
  if (b64) {
    try {
      return JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    } catch {
      console.warn("[GCS] GOOGLE_CREDENTIALS_JSON_B64 could not be decoded — trying raw JSON");
    }
  }
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      console.warn("[GCS] GOOGLE_CREDENTIALS_JSON set but could not be parsed — using default credentials");
    }
  }
  return undefined;
}

/**
 * Default openclaw.json seeded into {userId}/mountfolder/openclaw.json at provisioning time.
 * Gateway token and Cloud Run serviceUrl are injected so authentication and proxy trust work
 * correctly from the first container start.
 *
 * @param {string} gatewayToken  - Auth token for the mawaDao Agent gateway.
 * @param {string} [serviceUrl]  - Cloud Run service URL (e.g. https://mawadao-foo-xxxx.run.app).
 *                                 Added to trustedProxies and controlUi.allowedOrigins so the
 *                                 gateway accepts requests routed through Cloud Run's load balancer.
 */
function buildDefaultGatewayConfig(gatewayToken, serviceUrl, subdomain) {
  const now = new Date().toISOString();

  // Cloud Run generates two URL formats per service:
  //   New:    https://{service}-{projectNumber}.{region}.run.app
  //   Legacy: https://{service}-{legacyHash}-{regionCode}.a.run.app
  // Both must appear in trustedProxies (bare hostname + full https) for gateway to work.
  const legacyHash = process.env.CLOUD_RUN_LEGACY_HASH || "nz5hxkrkiq";
  const projectNumber = process.env.GCP_PROJECT_NUMBER || "";
  const region = process.env.GCP_REGION || config.cloudRun.region || "europe-west1";

  // Build legacy region abbreviation: europe-west1 → "ew"
  const regionParts = region.split("-");
  const regionAbbrev = regionParts.length >= 2
    ? regionParts[0][0] + regionParts[1][0]
    : regionParts[0].slice(0, 2);

  const trustedProxies = [];
  const allowedOrigins = ["https://platform.mawadao.com", "https://mawadao.com"];

  if (serviceUrl && subdomain) {
    const serviceName = `mawadao-${subdomain}`;

    // Detect which format serviceUrl is, and build the other
    // Legacy format contains ".a.run.app", new format contains ".run.app" but NOT ".a.run.app"
    const isLegacyUrl = serviceUrl.includes(".a.run.app");

    let newHostname, legacyHostname;
    if (isLegacyUrl) {
      // serviceUrl IS legacy → derive new format
      legacyHostname = new URL(serviceUrl).hostname;
      newHostname = `${serviceName}-${projectNumber}.${region}.run.app`;
    } else {
      // serviceUrl IS new → derive legacy format
      newHostname = new URL(serviceUrl).hostname;
      legacyHostname = `${serviceName}-${legacyHash}-${regionAbbrev}.a.run.app`;
    }

    const newUrl = `https://${newHostname}`;
    const legacyUrl = `https://${legacyHostname}`;

    // Trusted proxies: bare hostnames first, then 127.0.0.1, then full https URLs
    trustedProxies.push(newHostname);
    trustedProxies.push(legacyHostname);
    trustedProxies.push("127.0.0.1");
    trustedProxies.push(newUrl);
    trustedProxies.push(legacyUrl);

    // Allowed origins get both URLs
    allowedOrigins.push(newUrl);
    allowedOrigins.push(legacyUrl);
  } else if (serviceUrl) {
    try { trustedProxies.push(new URL(serviceUrl).hostname); } catch {}
    trustedProxies.push("127.0.0.1");
    trustedProxies.push(serviceUrl);
    allowedOrigins.push(serviceUrl);
  } else {
    trustedProxies.push("127.0.0.1");
  }
  allowedOrigins.push(MEMBER_SPACE_URL);

  return {
    meta: {
      lastTouchedVersion: "2026.2.6-3",
      lastTouchedAt: now,
    },
    wizard: {
      lastRunAt: now,
      lastRunVersion: "2026.2.6-3",
      lastRunCommand: "configure",
      lastRunMode: "local",
    },
    auth: {
      profiles: {
        "moonshot:default": {
          provider: "moonshot",
          mode: "api_key",
        },
        "openrouter:default": {
          provider: "openrouter",
          mode: "api_key",
        },
      },
    },
    models: {
      mode: "merge",
      providers: {
        moonshot: {
          baseUrl: "https://api.moonshot.ai/v1",
          api: "openai-completions",
          models: [
            {
              id: "kimi-k2.6",
              name: "Kimi K2.6",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 256000,
              maxTokens: 8192,
            },
          ],
          apiKey: "MOONSHOT_API_KEY",
        },
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          api: "openai-completions",
          models: [
            {
              id: "minimax/minimax-m2.7",
              name: "MiniMax M2.7",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 256000,
              maxTokens: 8192,
            },
          ],
          apiKey: "OPENROUTER_API_KEY",
        },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: "moonshot/kimi-k2.6",
          fallbacks: ["openrouter/minimax/minimax-m2.7"],
        },
        models: {
          "moonshot/kimi-k2.6": { alias: "Kimi" },
          "openrouter/minimax/minimax-m2.7": { alias: "MiniMax" },
        },
        workspace: "/home/node/.openclaw/workspace",
        compaction: { mode: "default" },
        maxConcurrent: 4,
        subagents: { maxConcurrent: 8 },
      },
    },
    messages: {
      ackReactionScope: "group-mentions",
    },
    commands: {
      native: false,
      nativeSkills: false,
    },
    channels: {
      discord: { enabled: false },
    },
    gateway: {
      port: 8080,
      mode: "local",
      bind: "lan",
      controlUi: {
        allowedOrigins,
        dangerouslyDisableDeviceAuth: true,
      },
      auth: {
        mode: "token",
        token: gatewayToken || "",
      },
      trustedProxies,
      http: {
        endpoints: {
          chatCompletions: { enabled: true },
        },
      },
      tailscale: {
        mode: "off",
        resetOnExit: false,
      },
      remote: {
        url: "ws://127.0.0.1:8080",
      },
    },
    skills: {
      install: { nodeManager: "npm" },
    },
    tools: {
      web: {
        search: {
          enabled: true,
          provider: "brave",
          maxResults: 5,
          timeoutSeconds: 30,
          cacheTtlMinutes: 15,
        },
        fetch: {
          enabled: true,
        },
      },
    },
    plugins: {
      entries: {
        discord: { enabled: false },
      },
    },
  };
}

/**
 * Calls the mawadao-agent-storage service to scaffold the per-user folder structure
 * inside a tenant bucket and seed openclaw.json on first provisioning.
 *
 * Bucket layout created:
 *   {gcsBucket}/
 *     {userId}/
 *       userdata/        ← user uploads and persistent data
 *       mountfolder/     ← gcsfuse-mounted to /home/node/.openclaw at runtime
 *         openclaw.json  ← seeded with gateway token + defaults
 *
 * Non-fatal — logs warnings on failure rather than blocking provisioning.
 */
async function seedTenantBucketConfig(gcsBucket, userId, gatewayToken, serviceUrl, subdomain) {
  if (!STORAGE_URL) {
    console.warn("[mawadao-agent-storage] STORAGE_URL not set — skipping folder scaffold and openclaw.json seeding");
    return;
  }

  const headers = { "Content-Type": "application/json" };
  if (STORAGE_API_SECRET) {
    headers["X-Storage-Secret"] = STORAGE_API_SECRET;
  }

  const createFolder = async (path) => {
    try {
      const res = await fetch(`${STORAGE_URL}/api/v1/buckets/${encodeURIComponent(gcsBucket)}/folders`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.warn(`[mawadao-agent-storage] CreateFolder failed for ${gcsBucket}/${path} (HTTP ${res.status}): ${body}`);
      } else {
        console.log(`[mawadao-agent-storage] Created folder ${gcsBucket}/${path}`);
      }
    } catch (err) {
      console.warn(`[mawadao-agent-storage] CreateFolder request failed for ${gcsBucket}/${path}:`, err.message);
    }
  };

  // 1. Create {userId}/userdata/ and {userId}/mountfolder/ folder markers
  await createFolder(`${userId}/userdata`);
  await createFolder(`${userId}/mountfolder`);
  // Create the agent auth-profiles directory structure
  await createFolder(`${userId}/mountfolder/agents/main/agent`);

  // 2. Seed openclaw.json into {userId}/mountfolder/openclaw.json
  try {
    const defaultConfig = buildDefaultGatewayConfig(gatewayToken, serviceUrl, subdomain);
    const filePath = `${userId}/mountfolder/openclaw.json`;
    const fileRes = await fetch(
      `${STORAGE_URL}/api/v1/buckets/${encodeURIComponent(gcsBucket)}/files/${filePath}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify(defaultConfig, null, 2),
      }
    );
    if (!fileRes.ok) {
      const body = await fileRes.text();
      console.warn(`[mawadao-agent-storage] WriteFile failed for ${gcsBucket}/${filePath} (HTTP ${fileRes.status}): ${body}`);
    } else {
      console.log(`[mawadao-agent-storage] Seeded openclaw.json in ${gcsBucket}/${filePath}`);
    }
  } catch (err) {
    console.warn(`[mawadao-agent-storage] WriteFile request failed for ${gcsBucket}/${userId}/mountfolder/openclaw.json:`, err.message);
  }

  // 3. Seed auth-profiles.json with actual API key credentials
  //    mawaDao Agent resolves keys in order: auth-profiles.json → env var → models.json apiKey.
  //    We must seed this file so that even if the container MOONSHOT_API_KEY env var is
  //    empty (e.g. when the deployer itself doesn't have the key set), the agent still
  //    authenticates correctly on first boot.
  //
  //    IMPORTANT: MOONSHOT_API_KEY *must* be set in the deployer environment for new
  //    tenants to receive a working key. Without it, auth-profiles.json won't be seeded
  //    and the tenant will fail with HTTP 401 from the Moonshot API.
  const moonshotKey = sanitizeSecret(process.env.MOONSHOT_API_KEY || "");
  const openrouterKey = sanitizeSecret(process.env.OPENROUTER_API_KEY || "");
  const authProfiles = {};
  if (moonshotKey) {
    authProfiles["moonshot:default"] = { type: "api_key", provider: "moonshot", key: moonshotKey };
  }
  if (openrouterKey) {
    authProfiles["openrouter:default"] = { type: "api_key", provider: "openrouter", key: openrouterKey };
  }
  if (Object.keys(authProfiles).length > 0) {
    try {
      const authProfileStore = { version: 1, profiles: authProfiles };
      const authPath = `${userId}/mountfolder/agents/main/agent/auth-profiles.json`;
      const authRes = await fetch(
        `${STORAGE_URL}/api/v1/buckets/${encodeURIComponent(gcsBucket)}/files/${authPath}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify(authProfileStore, null, 2),
        }
      );
      if (!authRes.ok) {
        const body = await authRes.text();
        console.warn(`[mawadao-agent-storage] WriteFile failed for ${gcsBucket}/${authPath} (HTTP ${authRes.status}): ${body}`);
      } else {
        const keys = Object.keys(authProfiles).join(", ");
        console.log(`[mawadao-agent-storage] Seeded auth-profiles.json (${keys}) in ${gcsBucket}/${authPath}`);
      }
    } catch (err) {
      console.warn(`[mawadao-agent-storage] WriteFile request failed for auth-profiles.json:`, err.message);
    }
  } else {
    console.warn(
      "[mawadao-agent-storage] MOONSHOT_API_KEY is not set in the deployer environment — " +
      "auth-profiles.json not seeded. Set this env var in the deployer Cloud Run service to fix new tenant provisioning."
    );
  }

  // 4. Seed models.json at agents/main/agent/models.json
  //    This is the per-agent provider config. Mirror Alien's working Moonshot-first setup.
  //    mawaDao Agent checks this as a fallback when auth-profiles.json and env vars don't resolve.
  try {
    const agentModels = {
      providers: {
        moonshot: {
          baseUrl: "https://api.moonshot.ai/v1",
          api: "openai-completions",
          models: [
            {
              id: "kimi-k2.6",
              name: "Kimi K2.6",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 256000,
              maxTokens: 8192,
            },
          ],
          apiKey: "MOONSHOT_API_KEY",
        },
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          api: "openai-completions",
          models: [
            {
              id: "minimax/minimax-m2.7",
              name: "MiniMax M2.7",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 256000,
              maxTokens: 8192,
            },
          ],
          apiKey: "OPENROUTER_API_KEY",
        },
      },
    };
    const modelsPath = `${userId}/mountfolder/agents/main/agent/models.json`;
    const modelsRes = await fetch(
      `${STORAGE_URL}/api/v1/buckets/${encodeURIComponent(gcsBucket)}/files/${modelsPath}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify(agentModels, null, 2),
      }
    );
    if (!modelsRes.ok) {
      const body = await modelsRes.text();
      console.warn(`[mawadao-agent-storage] WriteFile failed for ${gcsBucket}/${modelsPath} (HTTP ${modelsRes.status}): ${body}`);
    } else {
      console.log(`[mawadao-agent-storage] Seeded models.json in ${gcsBucket}/${modelsPath}`);
    }
  } catch (err) {
    console.warn(`[mawadao-agent-storage] WriteFile request failed for models.json:`, err.message);
  }
}

const router = Router();

/** Shared secret that the frontend must supply to call deployer APIs */
const DEPLOYER_API_SECRET = process.env.DEPLOYER_API_SECRET || "";

/**
 * Authentication middleware for deployer routes.
 * Requires X-Deployer-Secret header matching DEPLOYER_API_SECRET.
 */
function requireDeployerAuth(req, res, next) {
  if (!DEPLOYER_API_SECRET) {
    // If no secret is configured, deny all external requests in production
    if (process.env.NODE_ENV === "production") {
      return res.status(503).json({
        success: false,
        message: "Deployer API secret not configured",
      });
    }
    return next(); // Allow in development without secret
  }

  const provided = req.headers["x-deployer-secret"];
  if (!provided || typeof provided !== "string") {
    return res.status(401).json({
      success: false,
      message: "Invalid deployer API credentials",
    });
  }
  const expected = Buffer.from(DEPLOYER_API_SECRET);
  const given = Buffer.from(provided);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return res.status(401).json({
      success: false,
      message: "Invalid deployer API credentials",
    });
  }
  next();
}

// Apply auth to all tenant routes
router.use(requireDeployerAuth);

/** Cloud container image for per-user backends */
const CLOUD_BACKEND_IMAGE =
  process.env.CLOUD_BACKEND_IMAGE ||
  "ghcr.io/mawadao/mawadao-agent-gateway:latest";

/** Gateway token sourced from environment — never hardcode */
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";

/** Shared env vars injected into every tenant backend */
const SHARED_ENV = {
  DATABASE_URL: process.env.DATABASE_URL || "",
  JWT_SECRET: process.env.JWT_SECRET || "change-this-jwt-secret",
  MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY || "",
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
  BRAVE_API_KEY: process.env.BRAVE_API_KEY || "",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  OPENCLAW_CLOUD_MODE: "true",
  OPENCLAW_REST_API: "1",
  NODE_ENV: "production",
};

/**
 * POST /tenants/provision
 *
 * Body:
 *   - subdomain (string, required): User's chosen subdomain (e.g. "alice")
 *   - userId (string, required): User UUID
 *   - tenantId (string, required): Tenant UUID
 *   - gatewayToken (string, optional): Override gateway token (falls back to OPENCLAW_GATEWAY_TOKEN env var)
 *   - region (string, optional): GCP region (default: europe-west1)
 */
router.post(
  "/provision",
  asyncHandler(async (req, res) => {
    const { subdomain, userId, tenantId, gatewayToken, region, containerImage } = req.body;

    // Use env-sourced token by default; only allow override if provided
    const resolvedGatewayToken = gatewayToken || OPENCLAW_GATEWAY_TOKEN;

    if (!subdomain || !userId || !tenantId) {
      return res.status(400).json({
        success: false,
        message: "subdomain, userId, and tenantId are required",
      });
    }

    if (!resolvedGatewayToken) {
      return res.status(500).json({
        success: false,
        message: "Gateway token not configured (set OPENCLAW_GATEWAY_TOKEN env var)",
      });
    }

    // Validate subdomain format
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(subdomain) || subdomain.length > 63) {
      return res.status(400).json({
        success: false,
        message: "subdomain must be a DNS-safe label (lowercase alphanumeric + hyphens)",
      });
    }

    const serviceName = `mawadao-${subdomain}`;
    const resolvedContainerImage =
      typeof containerImage === "string" && containerImage.trim()
        ? containerImage.trim()
        : CLOUD_BACKEND_IMAGE;
    // All tenants share a single pre-existing bucket; mawadao-agent-storage SA already has objectAdmin on it.
    const gcsBucket = process.env.GCS_BUCKET_NAME || "mawadao-agent-data";
    const deployRegion = region || config.cloudRun.region || "europe-west1";

    // Pre-compute the Cloud Run service URL — the format is deterministic:
    // https://{serviceName}-{projectNumber}.{region}.run.app
    // Seeding the config BEFORE deploying ensures the container starts up with
    // chatCompletions.enabled=true already in place (openAiChatCompletionsEnabled
    // is locked in at binary startup, so the config must exist before first boot).
    const projectNumber = process.env.GCP_PROJECT_NUMBER || "";
    const predictedServiceUrl = `https://${serviceName}-${projectNumber}.${deployRegion}.run.app`;

    // Seed openclaw.json BEFORE deploying so the container reads the correct config on first boot.
    await seedTenantBucketConfig(gcsBucket, userId, resolvedGatewayToken, predictedServiceUrl, subdomain);

    // GCS subfolder that maps to the user's config at runtime
    const gcsSubfolder = `${userId}/mountfolder`;

    const env = [
      ...Object.entries(SHARED_ENV).map(([name, value]) => ({ name, value })),
      { name: "GCS_BUCKET", value: gcsBucket },
      { name: "GCS_SUBFOLDER", value: gcsSubfolder },
      { name: "OPENCLAW_GATEWAY_TOKEN", value: resolvedGatewayToken },
      { name: "TENANT_ID", value: tenantId },
      { name: "USER_ID", value: userId },
      { name: "SUBDOMAIN", value: subdomain },
    ];

    const result = await CloudRunDeployService.deploy({
      serviceName,
      containerImage: resolvedContainerImage,
      region: deployRegion,
      env,
      resources: { cpu: "1", memory: "2Gi", cpuIdle: true },
      minInstances: 0,
      maxInstances: 3,
      // Phase B (RFC: Resilient Long-Running Chat):
      // Long agent runs hold a worker for minutes; default concurrency 80
      // means up to 80 simultaneous long jobs per container, which starves
      // the Node event loop and balloons tail latency. Cap at 8.
      concurrency: 8,
      // Phase A stopgap (RFC: Resilient Long-Running Chat):
      // Bumped from 300s -> 3600s (Cloud Run hard max). Long agent runs with
      // tool use frequently exceed 5 minutes; the request was being killed
      // mid-stream by the platform's route timeout. The browser-side proxy
      // (/api/ai-chat) and the streaming pump already cap effective work via
      // their own watchdogs (STREAM_READ_TIMEOUT_MS, MAX_CONTINUATIONS).
      // NOTE: existing tenants keep their original timeout until their next
      // deploy/redeploy; operators can update them via:
      //   gcloud run services update mawadao-{sub} --timeout=3600 \
      //     --region=europe-west1 --project=mawadao-customer-side
      timeout: "3600s",
      description: `mawaDao Cloud backend for ${subdomain}`,
      publicAccess: true,
      // Mount the user's GCS subfolder at the state directory.
      // only-dir scopes the gcsfuse mount to {userId}/mountfolder/ so that
      // openclaw.json appears at /home/node/.openclaw/openclaw.json as expected.
      executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
      volumes: [
        {
          name: "gcs-state",
          gcs: {
            bucket: gcsBucket,
            readOnly: false,
            // only-dir scopes the mount to the user's subfolder.
            // metadata-cache-ttl-secs=0 and stat-cache-max-size-mb=0 disable caching so
            // writes (e.g. IDENTITY.md, MEMORY.md) are flushed to GCS immediately and
            // are visible on the next read without stale-cache misses after scale-to-zero.
            mountOptions: [
              `only-dir=${gcsSubfolder}`,
              "metadata-cache-ttl-secs=0",
              "stat-cache-max-size-mb=0",
              "type-cache-max-size-mb=0",
            ],
          },
        },
      ],
      volumeMounts: [
        {
          name: "gcs-state",
          mountPath: "/home/node/.openclaw",
        },
      ],
    });

    created(res, {
      serviceName: result.serviceName,
      serviceUrl: result.serviceUrl,
      region: result.region,
      status: result.status,
      gcsBucket,
      subdomain,
    });
  })
);

/**
 * DELETE /tenants/:subdomain
 * Deletes the Cloud Run service for a given tenant subdomain.
 * Query params:
 *   - userId (optional): If provided, also deletes the user's folder from the shared GCS bucket.
 */
router.delete(
  "/:subdomain",
  asyncHandler(async (req, res) => {
    const { subdomain } = req.params;
    const userId = req.query.userId || null;
    const serviceName = `mawadao-${subdomain}`;
    const region = req.query.region || config.cloudRun.region || "europe-west1";

    const result = await CloudRunDeployService.deleteService(serviceName, { region });

    // Delete the user's GCS folder from the shared bucket (best-effort)
    let gcsFolderDeleted = false;
    if (userId && STORAGE_URL) {
      const gcsBucket = process.env.GCS_BUCKET_NAME || "mawadao-agent-data";
      const headers = {};
      if (STORAGE_API_SECRET) headers["X-Storage-Secret"] = STORAGE_API_SECRET;
      try {
        const gcsRes = await fetch(
          `${STORAGE_URL}/api/v1/buckets/${encodeURIComponent(gcsBucket)}/folders/${userId}`,
          { method: "DELETE", headers }
        );
        if (gcsRes.ok) {
          gcsFolderDeleted = true;
          console.log(`[mawadao-agent-storage] Deleted GCS folder for user ${userId}`);
        } else {
          const body = await gcsRes.text();
          console.warn(`[mawadao-agent-storage] GCS folder delete failed for ${userId} (HTTP ${gcsRes.status}): ${body}`);
        }
      } catch (gcsErr) {
        console.warn(`[mawadao-agent-storage] GCS folder delete error for ${userId}:`, gcsErr.message);
      }
    }

    success(res, {
      deleted: result.deleted,
      serviceName: result.serviceName,
      subdomain,
      region: result.region,
      gcsFolderDeleted,
    });
  })
);

module.exports = router;
module.exports.seedTenantBucketConfig = seedTenantBucketConfig;
