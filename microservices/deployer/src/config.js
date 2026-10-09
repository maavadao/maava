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
  storage: {
    url: process.env.STORAGE_URL || "http://localhost:8090",
    bucket: process.env.STORAGE_BUCKET || "",
    mountPath: process.env.STORAGE_MOUNT_PATH || "/home/node/.openclaw",
    // Shared secret sent as X-Storage-Secret on every write request.
    // Must match STORAGE_API_SECRET on the maava-storage service.
    apiSecret: process.env.STORAGE_API_SECRET || "",
  },
};
