import "dotenv/config";
import axios, { AxiosError } from "axios";
import fs from "fs";
import path from "path";
import { taxonomyData } from "./taxonomy.data.js";
import { CauseTag, type CauseStatementRequest } from "./request.interface.js";
import type { CauseStatementResponse } from "./response.interface.js";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const JWT_TOKEN = process.env.JWT_TOKEN;
const USER_UUID = process.env.USER_UUID;
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? "5", 10);

if (!JWT_TOKEN) {
  console.error("ERROR: JWT_TOKEN is not set in .env");
  process.exit(1);
}
if (!USER_UUID) {
  console.error("ERROR: USER_UUID is not set in .env");
  process.exit(1);
}

const BASE_URL = `https://api.test-004.doublegood.com/ai-assistant/users/${USER_UUID}/text-generation/cause`;

// ---------------------------------------------------------------------------
// Randomisation helpers
// ---------------------------------------------------------------------------

const EVENT_NAMES = [
  "Spring Fundraiser",
  "Annual Drive",
  "Fall Campaign",
  "End-of-Year Gala",
  "Community Bash",
];

const ORG_NAMES = [
  "Lincoln High School",
  "Riverside Community",
  "Sunset Academy",
  "Greenwood Booster Club",
  "Maplewood Athletics",
];

const ALL_TAGS = Object.values(CauseTag);

function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Returns a random non-empty subset of CauseTag values */
function randomTags(): CauseTag[] {
  const shuffled = [...ALL_TAGS].sort(() => Math.random() - 0.5);
  const count = Math.max(1, Math.floor(Math.random() * shuffled.length));
  return shuffled.slice(0, count);
}

// ---------------------------------------------------------------------------
// Combination generation
// ---------------------------------------------------------------------------

interface Combination {
  FUNDRAISER_ORGANIZATION_TYPE: string;
  FUNDRAISER_ACTIVITY: string;
  FUNDRAISER_AFFILIATION?: string;
}

function buildCombinations(): Combination[] {
  const combos: Combination[] = [];
  for (const category of taxonomyData) {
    if (!("activities" in category) || !category.activities) continue;
    for (const activity of category.activities) {
      if ("affiliations" in activity && activity.affiliations && activity.affiliations.length > 0) {
        for (const affiliation of activity.affiliations) {
          combos.push({
            FUNDRAISER_ORGANIZATION_TYPE: category.name,
            FUNDRAISER_ACTIVITY: activity.name,
            FUNDRAISER_AFFILIATION: affiliation,
          });
        }
      } else {
        combos.push({
          FUNDRAISER_ORGANIZATION_TYPE: category.name,
          FUNDRAISER_ACTIVITY: activity.name,
        });
      }
    }
  }
  return combos;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface RunResult {
  combination: Combination;
  request: CauseStatementRequest;
  response: CauseStatementResponse | null;
  httpStatus: number | null;
  latencyMs: number;
  failed: boolean;
  failReason: string | null;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Request execution
// ---------------------------------------------------------------------------

async function runRequest(combo: Combination, index: number, total: number): Promise<RunResult> {
  const request: CauseStatementRequest = {
    tags: randomTags(),
    template: {
      replaceable_attributes: {
        FUNDRAISING_EVENT_NAME: randomPick(EVENT_NAMES),
        FUNDRAISER_ORGANIZATION_NAME: randomPick(ORG_NAMES),
        FUNDRAISER_ORGANIZATION_TYPE: combo.FUNDRAISER_ORGANIZATION_TYPE,
        FUNDRAISER_ACTIVITY: combo.FUNDRAISER_ACTIVITY,
        ...(combo.FUNDRAISER_AFFILIATION
          ? { FUNDRAISER_AFFILIATION: combo.FUNDRAISER_AFFILIATION }
          : {}),
      },
    },
  };

  const label =
    `[${String(index + 1).padStart(String(total).length, " ")}/${total}]` +
    ` ${combo.FUNDRAISER_ORGANIZATION_TYPE} › ${combo.FUNDRAISER_ACTIVITY}` +
    (combo.FUNDRAISER_AFFILIATION ? ` › ${combo.FUNDRAISER_AFFILIATION}` : "");

  const t0 = Date.now();

  try {
    const { data, status } = await axios.post<CauseStatementResponse>(BASE_URL, request, {
      headers: {
        Authorization: `${JWT_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    const latencyMs = Date.now() - t0;
    const textEmpty = !data.text || data.text.trim() === "";
    const failed = data.generated === false || textEmpty;
    const failReason = failed
      ? [data.generated === false ? "generated=false" : "", textEmpty ? "empty text" : ""]
          .filter(Boolean)
          .join(", ")
      : null;

    const icon = failed ? "✗" : "✓";
    const detail = failed ? `  ← ${failReason}` : "";
    console.log(`  ${icon} ${label}  (${latencyMs}ms)${detail}`);

    return { combination: combo, request, response: data, httpStatus: status, latencyMs, failed, failReason };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const axiosErr = err as AxiosError;
    const status = axiosErr.response?.status ?? null;
    const message = axiosErr.message;
    console.log(`  ✗ ${label}  (${latencyMs}ms)  ← HTTP error ${status ?? "network"}: ${message}`);
    return {
      combination: combo,
      request,
      response: null,
      httpStatus: status,
      latencyMs,
      failed: true,
      failReason: `HTTP error ${status ?? "network"}`,
      errorMessage: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

async function runWithConcurrency(
  combos: Combination[],
  concurrency: number
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  const total = combos.length;
  let index = 0;

  async function worker() {
    while (index < total) {
      const i = index++;
      const result = await runRequest(combos[i], i, total);
      results.push(result);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, worker);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const combos = buildCombinations();
  console.log(`\nAI Cause Statement Tester`);
  console.log(`Endpoint : ${BASE_URL}`);
  console.log(`Total    : ${combos.length} combinations`);
  console.log(`Concurr. : ${CONCURRENCY}\n`);

  const startedAt = Date.now();
  const results = await runWithConcurrency(combos, CONCURRENCY);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  // --- Summary ---
  const failed = results.filter((r) => r.failed);
  const passed = results.length - failed.length;
  const rate = ((failed.length / results.length) * 100).toFixed(1);
  const latencies = results.map((r) => r.latencyMs);
  const avgLatency = (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0);
  const minLatency = Math.min(...latencies);
  const maxLatency = Math.max(...latencies);
  const p95Latency = latencies.slice().sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)];

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Results`);
  console.log(`${"─".repeat(60)}`);
  console.log(`  Total   : ${results.length}`);
  console.log(`  Passed  : ${passed}`);
  console.log(`  Failed  : ${failed.length} (${rate}%)`);
  console.log(`  Time    : ${elapsed}s`);
  console.log(`  Latency : avg ${avgLatency}ms  min ${minLatency}ms  max ${maxLatency}ms  p95 ${p95Latency}ms`);

  if (failed.length > 0) {
    console.log(`\nFailed combinations:`);
    for (const r of failed) {
      const c = r.combination;
      const name =
        `${c.FUNDRAISER_ORGANIZATION_TYPE} › ${c.FUNDRAISER_ACTIVITY}` +
        (c.FUNDRAISER_AFFILIATION ? ` › ${c.FUNDRAISER_AFFILIATION}` : "");
      console.log(`  ✗  ${name}  [${r.failReason}]`);
    }
  }

  // --- Save results file ---
  const resultsDir = path.join(process.cwd(), "results");
  fs.mkdirSync(resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(resultsDir, `run-${timestamp}.json`);

  const output = {
    meta: {
      runAt: new Date().toISOString(),
      endpoint: BASE_URL,
      total: results.length,
      passed,
      failed: failed.length,
      failureRate: `${rate}%`,
      elapsedSeconds: parseFloat(elapsed),
      latency: {
        avgMs: parseInt(avgLatency),
        minMs: minLatency,
        maxMs: maxLatency,
        p95Ms: p95Latency,
      },
    },
    failures: failed,
    all: results,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  // --- Write CSV ---
  const csvPath = path.join(resultsDir, `run-${timestamp}.csv`);
  const csvHeader = [
    "organization_type",
    "activity",
    "affiliation",
    "event_name",
    "org_name",
    "tags",
    "http_status",
    "latency_ms",
    "generated",
    "failed",
    "fail_reason",
    "text",
  ].join(",");

  const csvRows = results.map((r) => {
    const csvField = (v: string | null | undefined) =>
      `"${String(v ?? "").replace(/"/g, '""')}"`;
    return [
      csvField(r.combination.FUNDRAISER_ORGANIZATION_TYPE),
      csvField(r.combination.FUNDRAISER_ACTIVITY),
      csvField(r.combination.FUNDRAISER_AFFILIATION),
      csvField(r.request.template.replaceable_attributes.FUNDRAISING_EVENT_NAME),
      csvField(r.request.template.replaceable_attributes.FUNDRAISER_ORGANIZATION_NAME),
      csvField(r.request.tags.join("|")),
      r.httpStatus ?? "",
      r.latencyMs,
      r.response?.generated ?? "",
      r.failed,
      csvField(r.failReason),
      csvField(r.response?.text),
    ].join(",");
  });

  fs.writeFileSync(csvPath, [csvHeader, ...csvRows].join("\n"));

  console.log(`Results saved → ${path.relative(process.cwd(), outPath)}`);
  console.log(`CSV saved     → ${path.relative(process.cwd(), csvPath)}\n`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
