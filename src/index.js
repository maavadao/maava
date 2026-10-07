/**
 * Cloud Run Deployer - HTTP server
 */

const app = require("./app");
const config = require("./config");

const port = config.port;
const server = app.listen(port, () => {
  console.log(`Cloud Run Deployer listening on port ${port}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  // Force exit if server.close() hangs
  setTimeout(() => process.exit(0), 3000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Prevent gRPC / google-auth-library errors from crashing the process.
// These are emitted as unhandled rejections when GCP credentials are absent locally.
process.on('unhandledRejection', (reason) => {
  console.error('[deployer] Unhandled rejection (non-fatal):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[deployer] Uncaught exception (non-fatal):', err.message);
});
