/**
 * Express application for Cloud Run Deployer API
 */

const express = require("express");
const helmet = require("helmet");
const routes = require("./routes");
const config = require("./config");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");

const app = express();

app.use(helmet());
app.use(express.json({ limit: "1mb" }));

app.use("/api/v1", routes);

app.get("/", (req, res) => {
  res.json({
    name: "Cloud Run Deployer",
    version: "1.0.0",
    endpoints: {
      deploy: "POST   /api/v1/cloud-run/deploy",
      deleteService: "DELETE /api/v1/cloud-run/services/:serviceName",
      health: "GET    /healthz",
    },
  });
});

/**
 * GET /health
 * Deep health check: verifies GCP credentials and mawadao-agent-storage reachability.
 * Returns 200 when all checks pass, 503 when any check fails.
 *
 * Response shape:
 * {
 *   status: "healthy" | "degraded",
 *   timestamp: string,
 *   uptime: number,
 *   checks: {
 *     gcp:            { ok: boolean, projectId: string, region: string, error?: string },
 *     storage:  { ok: boolean, url: string, bucket: string, error?: string },
 *     template:       { ok: boolean, path: string, error?: string }
 *   }
 * }
 */
app.get("/healthz", async (req, res) => {
  const checks = {};

  // ── 1. GCP credentials ──────────────────────────────────────────────────────
  try {
    const { ServicesClient } = require("@google-cloud/run");
    const client = new ServicesClient();
    // getProjectId() is a lightweight ADC probe — no network call to Cloud Run.
    await client.getProjectId();
    checks.gcp = {
      ok: true,
      projectId: config.cloudRun.projectId || "(from ADC)",
      region: config.cloudRun.region,
    };
  } catch (err) {
    checks.gcp = {
      ok: false,
      projectId: config.cloudRun.projectId || "",
      region: config.cloudRun.region,
      error: err.message,
    };
  }

  // ── 2. Bucket-manager reachability ──────────────────────────────────────────
  const bmUrl = config.storage.url.replace(/\/+$/, "");
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const bmRes = await fetch(`${bmUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    const bmBody = await bmRes.json().catch(() => ({}));
    checks.storage = {
      ok: bmRes.ok,
      url: bmUrl,
      bucket: config.storage.bucket || "(not set)",
      ...(bmRes.ok ? {} : { error: bmBody?.error ?? `HTTP ${bmRes.status}` }),
    };
  } catch (err) {
    checks.storage = {
      ok: false,
      url: bmUrl,
      bucket: config.storage.bucket || "(not set)",
      error: err.name === "AbortError" ? "timeout after 4s" : err.message,
    };
  }

  // ── 3. YAML template readable ────────────────────────────────────────────────
  try {
    const fs = require("node:fs");
    fs.accessSync(config.cloudRun.templatePath, fs.constants.R_OK);
    checks.template = { ok: true, path: config.cloudRun.templatePath };
  } catch (err) {
    checks.template = {
      ok: false,
      path: config.cloudRun.templatePath,
      error: err.message,
    };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  const status = allOk ? "healthy" : "degraded";

  res.status(allOk ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    checks,
  });
});

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
