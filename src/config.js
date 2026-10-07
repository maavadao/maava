/**
 * Application configuration
 */

const path = require("node:path");

require("dotenv").config();

const defaultTemplatePath = path.join(
  __dirname,
  "../templates/cloud-run-service.yaml"
);

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || "development",
  isProduction: process.env.NODE_ENV === "production",
  cloudRun: {
    projectId: process.env.GCP_PROJECT_ID || "",
    region: process.env.GCP_REGION || "europe-west1",
    templatePath: process.env.CLOUD_RUN_TEMPLATE_PATH
    ? path.resolve(process.cwd(), process.env.CLOUD_RUN_TEMPLATE_PATH)
    : defaultTemplatePath,
  },
  // Bucket-manager integration: folder is created before each Cloud Run deploy,
  // then mounted as a GCS volume inside the container at /home/node/.openclaw.
  bucketManager: {
    url: process.env.BUCKET_MANAGER_URL || "http://localhost:8090",
    bucket: process.env.BUCKET_MANAGER_BUCKET || "",
    mountPath: process.env.BUCKET_MANAGER_MOUNT_PATH || "/home/node/.openclaw",
    // Shared secret sent as X-Bucket-Manager-Secret on every write request.
    // Must match BUCKET_MANAGER_API_SECRET on the bucket-manager service.
    apiSecret: process.env.BUCKET_MANAGER_API_SECRET || "",
  },
};
