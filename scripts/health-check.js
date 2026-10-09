#!/usr/bin/env node
/**
 * maavaDao Multi-Service Health Check
 *
 * Probes every service's /health endpoint and reports status.
 * Exit code 0 if all critical services are healthy, 1 otherwise.
 *
 * Usage:
 *   node scripts/health-check.js              # default localhost ports
 *   node scripts/health-check.js --json       # JSON output
 *   node scripts/health-check.js --timeout 5  # 5 second timeout per probe
 *
 * Environment:
 *   CONFIG_API_URL     (default: http://localhost:3003)
 *   AUTH_URL           (default: http://localhost:8080)
 *   DEPLOYER_URL       (default: http://localhost:3002)
 *   DNS_URL            (default: http://localhost:3004)
 */

const http = require("http");
const https = require("https");

// ── Configuration ─────────────────────────────────────────

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const timeoutIdx = args.indexOf("--timeout");
const TIMEOUT_MS =
  timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) * 1000 : 3000;

const SERVICES = [
  {
    name: "Configuration API",
    url: `${process.env.CONFIG_API_URL || "http://localhost:3003"}/api/v1/health`,
    critical: true,
  },
  {
    name: "Auth Service",
    url: `${process.env.AUTH_URL || "http://localhost:8080"}/health`,
    critical: true,
  },
  {
    name: "Cloud Run Deployer",
    url: `${process.env.DEPLOYER_URL || "http://localhost:3002"}/health`,
    critical: false,
  },
  {
    name: "DNS Service",
    url: `${process.env.DNS_URL || "http://localhost:3004"}/api/v1/dns/health`,
    critical: false,
  },
];

// ── Probe function ─────────────────────────────────────────

function probe(url) {
  return new Promise((resolve) => {
    const start = Date.now();
    const mod = url.startsWith("https") ? https : http;

    const req = mod.get(url, { timeout: TIMEOUT_MS }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        const latency = Date.now() - start;
        let body;
        try {
          body = JSON.parse(data);
        } catch {
          body = null;
        }
        resolve({
          status: res.statusCode < 500 ? "up" : "degraded",
          httpStatus: res.statusCode,
          latency,
          body,
        });
      });
    });

    req.on("error", () => {
      resolve({
        status: "down",
        httpStatus: null,
        latency: Date.now() - start,
        body: null,
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({
        status: "timeout",
        httpStatus: null,
        latency: TIMEOUT_MS,
        body: null,
      });
    });
  });
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  const results = await Promise.all(
    SERVICES.map(async (svc) => {
      const result = await probe(svc.url);
      return { ...svc, ...result };
    })
  );

  if (jsonOutput) {
    const out = {
      timestamp: new Date().toISOString(),
      services: results.map((r) => ({
        name: r.name,
        url: r.url,
        status: r.status,
        httpStatus: r.httpStatus,
        latencyMs: r.latency,
        critical: r.critical,
        details: r.body,
      })),
    };
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log("\n  maavaDao Health Check\n");
    console.log("=".repeat(60));

    for (const r of results) {
      const icon =
        r.status === "up" ? "\x1b[32m✓\x1b[0m" :
        r.status === "degraded" ? "\x1b[33m~\x1b[0m" :
        "\x1b[31m✗\x1b[0m";

      const tag = r.critical ? " [CRITICAL]" : "";
      const latency = r.latency != null ? ` (${r.latency}ms)` : "";
      const http = r.httpStatus != null ? ` HTTP ${r.httpStatus}` : "";
      console.log(`  ${icon} ${r.name}${tag}${http}${latency} — ${r.status}`);

      // Show sub-service details if available
      if (r.body?.services) {
        for (const [dep, depStatus] of Object.entries(r.body.services)) {
          const depIcon = depStatus === "up" ? "\x1b[32m·\x1b[0m" : "\x1b[31m·\x1b[0m";
          console.log(`      ${depIcon} ${dep}: ${depStatus}`);
        }
      }
    }

    console.log("\n" + "=".repeat(60));
  }

  const criticalDown = results.some(
    (r) => r.critical && r.status !== "up"
  );
  process.exit(criticalDown ? 1 : 0);
}

main().catch((err) => {
  console.error("Health check failed:", err.message);
  process.exit(1);
});
