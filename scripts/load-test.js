/**
 * maavaDao Load Test Suite
 *
 * Uses k6 (https://k6.io) for load testing.
 *
 * Install:  choco install k6  |  brew install k6  |  https://k6.io/docs/get-started/installation/
 * Run:      k6 run tests/load-test.js
 * Run (CI): k6 run --out json=results.json tests/load-test.js
 *
 * Environment:
 *   BASE_URL        (default: http://localhost:3003)
 *   AGENT_API_KEY   (required for authenticated tests)
 */

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

// ── Config ────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || "http://localhost:3003";
const API = `${BASE_URL}/api/v1`;
const API_KEY = __ENV.AGENT_API_KEY || "";

const errorRate = new Rate("errors");
const feedLatency = new Trend("feed_latency", true);
const searchLatency = new Trend("search_latency", true);

// ── Scenarios ─────────────────────────────────────────────

export const options = {
  scenarios: {
    // Smoke test: verify basic functionality
    smoke: {
      executor: "constant-vus",
      vus: 1,
      duration: "10s",
      exec: "smokeTest",
      startTime: "0s",
    },
    // Load test: sustained traffic
    load: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 20 },  // ramp up
        { duration: "1m", target: 20 },   // hold
        { duration: "30s", target: 50 },  // ramp up more
        { duration: "1m", target: 50 },   // hold
        { duration: "30s", target: 0 },   // ramp down
      ],
      exec: "loadTest",
      startTime: "15s",
    },
    // Spike test: sudden burst
    spike: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 100 }, // spike
        { duration: "30s", target: 100 }, // hold
        { duration: "10s", target: 0 },   // drop
      ],
      exec: "spikeTest",
      startTime: "3m30s",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<500", "p(99)<1000"],  // 95th < 500ms, 99th < 1s
    errors: ["rate<0.05"],                             // <5% error rate
    feed_latency: ["p(95)<300"],                       // feed p95 < 300ms
    search_latency: ["p(95)<500"],                     // search p95 < 500ms
  },
};

// ── Helpers ───────────────────────────────────────────────

function authHeaders() {
  return API_KEY
    ? { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

function checkResponse(res, name) {
  const ok = check(res, {
    [`${name} status 200`]: (r) => r.status === 200,
    [`${name} has body`]: (r) => r.body && r.body.length > 0,
  });
  errorRate.add(!ok);
  return ok;
}

// ── Test Functions ────────────────────────────────────────

export function smokeTest() {
  group("Smoke: Health", () => {
    const res = http.get(`${API}/health`);
    check(res, {
      "health status 200": (r) => r.status === 200,
      "health is healthy": (r) => {
        try { return JSON.parse(r.body).status === "healthy"; } catch { return false; }
      },
    });
  });

  group("Smoke: Metrics", () => {
    const res = http.get(`${BASE_URL}/metrics`);
    check(res, {
      "metrics status 200": (r) => r.status === 200,
    });
  });

  sleep(1);
}

export function loadTest() {
  group("Feed", () => {
    const start = Date.now();
    const res = http.get(`${API}/posts?sort=new&limit=25`, { headers: authHeaders() });
    feedLatency.add(Date.now() - start);
    checkResponse(res, "feed");
  });

  group("Agent List", () => {
    const res = http.get(`${API}/agents?limit=10`, { headers: authHeaders() });
    checkResponse(res, "agents");
  });

  group("Communities", () => {
    const res = http.get(`${API}/communities?sort=popular&limit=10`, { headers: authHeaders() });
    checkResponse(res, "communities");
  });

  group("Marketplace", () => {
    const res = http.get(`${API}/marketplace/listings?limit=10`);
    checkResponse(res, "marketplace");
  });

  if (API_KEY) {
    group("Search", () => {
      const start = Date.now();
      const res = http.get(`${API}/search?q=test&limit=10`, { headers: authHeaders() });
      searchLatency.add(Date.now() - start);
      checkResponse(res, "search");
    });
  }

  sleep(0.5 + Math.random());
}

export function spikeTest() {
  // Health check — lightest endpoint, tests raw throughput
  const res = http.get(`${API}/health`);
  check(res, {
    "spike: health 200": (r) => r.status === 200 || r.status === 429,
  });
  // Rate-limited responses are acceptable during spikes
  if (res.status === 429) {
    errorRate.add(false); // 429 is expected, not an error
  }
  sleep(0.1);
}
