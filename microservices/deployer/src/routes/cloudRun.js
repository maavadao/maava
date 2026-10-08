/**
 * Cloud Run deployment routes
 * POST /api/v1/cloud-run/deploy - Create/replace a Cloud Run service from base YAML + overrides
 * DELETE /api/v1/cloud-run/services/:serviceName - Delete a Cloud Run service
 * POST   /api/v1/cloud-run/services/:serviceName/restart - Restart a Cloud Run service
 */

const { Router } = require("express");
const crypto = require("crypto");
const { asyncHandler } = require("../middleware/errorHandler");
const { created, success } = require("../utils/response");
const config = require("../config");
const { seedTenantBucketConfig } = require("./tenants");
const CloudRunDeployService = require("../services/CloudRunDeployService");

const router = Router();

/** Shared secret for deployer API auth (same as tenants.js) */
const DEPLOYER_API_SECRET = process.env.DEPLOYER_API_SECRET || "";

/**
 * Authentication middleware for Cloud Run deploy routes.
 * Requires X-Deployer-Secret header matching DEPLOYER_API_SECRET.
 */
function requireDeployerAuth(req, res, next) {
  if (!DEPLOYER_API_SECRET) {
    if (process.env.NODE_ENV === "production") {
      return res.status(503).json({
        success: false,
        message: "Deployer API secret not configured",
      });
    }
    return next();
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

// Apply auth to all cloud-run routes
router.use(requireDeployerAuth);

/**
 * POST /cloud-run/deploy
 * Create a new Cloud Run service (or update if exists) using the base YAML template.
 *
 * Body:
 *   - serviceName     (string, required)  DNS-safe service name
 *   - containerImage  (string, required)  Container image URL
 *   - region          (string, optional)  GCP region (default from GCP_REGION / config)
 *   - projectId       (string, optional)  GCP project (default from GCP_PROJECT_ID / config)
 *   - env             (array,  optional)  Env vars as [{ name, value }] or ["KEY=value"]
 *   - resources       (object, optional)  { cpu, memory, cpuIdle }
 *   - minInstances    (number, optional)
 *   - maxInstances    (number, optional)
 *   - timeout         (string, optional)  e.g. "300s"
 *   - description     (string, optional)
 *   - publicAccess    (boolean,optional)  Allow unauthenticated access (default false)
 *   - folders         (string | string[] | Array<{path:string}>, optional)
 *       GCS folders to create via mawa-storage and mount into the container.
 *       Examples:
 *         "agents/main"
 *         ["agents/main", "agents/cron"]
 *         [{ "path": "agents/main" }, { "path": "agents/cron" }]
 *       Each folder is created in STORAGE_BUCKET and mounted under
 *       STORAGE_MOUNT_PATH (/home/node/.openclaw by default).
 *       The first folder is mounted at the base path; subsequent folders are
 *       mounted at <basePath>/<folderPath>.
 *
 * Returns: { success, status, serviceUrl, reconciling?, serviceName, region, latestReadyRevision?, folders }
 */
router.post(
  "/deploy",
  asyncHandler(async (req, res) => {
    const result = await CloudRunDeployService.deploy(req.body);

    // Seed openclaw.json into the tenant's mountfolder whenever gateway token + userId
    // are present in the env array (i.e. this is a tenant deploy, not a generic deploy).
    // This ensures the container always starts with a valid config file rather than falling
    // back to the bundled generic default which has no auth token.
    const envArr = Array.isArray(req.body.env) ? req.body.env : [];
    const findEnv = (name) => (envArr.find((e) => e && e.name === name) || {}).value || "";
    const gatewayToken = findEnv("OPENCLAW_GATEWAY_TOKEN");
    const userId = findEnv("USER_ID");
    const subdomain = findEnv("SUBDOMAIN");
    const gcsBucket = findEnv("GCS_BUCKET") || config.storage.bucket;

    if (gatewayToken && userId && config.storage.url) {
      // Non-blocking — seed failure must not prevent the deploy response
      seedTenantBucketConfig(gcsBucket, userId, gatewayToken, result.serviceUrl, subdomain)
        .catch((err) => console.warn("[cloud-run/deploy] seedTenantBucketConfig failed (non-fatal):", err.message));
    }

    created(res, {
      status: result.status,
      serviceUrl: result.serviceUrl,
      reconciling: result.reconciling,
      serviceName: result.serviceName,
      region: result.region,
      latestReadyRevision: result.latestReadyRevision,
      folders: result.folders,
    });
  })
);

/**
 * DELETE /cloud-run/services/:serviceName
 * Delete a Cloud Run service. Optional query: region, projectId (default from env/config).
 *
 * Returns: { success, deleted: true, serviceName, region }
 */
router.delete(
  "/services/:serviceName",
  asyncHandler(async (req, res) => {
    const { serviceName } = req.params;
    const projectId = req.query.projectId || undefined;
    const region = req.query.region || undefined;
    const result = await CloudRunDeployService.deleteService(serviceName, {
      projectId,
      region,
    });
    success(res, {
      deleted: result.deleted,
      serviceName: result.serviceName,
      region: result.region,
    });
  })
);

/**
 * POST /cloud-run/services/:serviceName/restart
 * Restart a Cloud Run service by forcing a new revision.
 *
 * Optional query params:
 *   - projectId
 *   - region
 *
 * Returns: { success, restarted: true, serviceName, region, latestReadyRevision? }
 */
router.post(
  "/services/:serviceName/restart",
  asyncHandler(async (req, res) => {
    const { serviceName } = req.params;
    const projectId = req.query.projectId || undefined;
    const region = req.query.region || undefined;
    const result = await CloudRunDeployService.restartService(serviceName, {
      projectId,
      region,
    });
    success(res, {
      restarted: result.restarted,
      serviceName: result.serviceName,
      region: result.region,
      latestReadyRevision: result.latestReadyRevision,
    });
  })
);

module.exports = router;
