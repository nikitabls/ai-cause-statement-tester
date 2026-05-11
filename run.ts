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
const RUNS_PER_COMBO = parseInt(process.env.RUNS_PER_COMBO ?? "1", 10);
const RETRY_ON_FAIL = parseInt(process.env.RETRY_ON_FAIL ?? "3", 10);

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

interface RetryAttempt {
  response: CauseStatementResponse | null;
  httpStatus: number | null;
  latencyMs: number;
  failed: boolean;
}

interface RunResult {
  combination: Combination;
  request: CauseStatementRequest;
  response: CauseStatementResponse | null;
  httpStatus: number | null;
  latencyMs: number;
  failed: boolean;
  failReason: string | null;
  errorMessage?: string;
  // Only populated when the initial attempt failed:
  retries: RetryAttempt[];
  // null = didn't fail; true = deterministic (all retries failed); false = flaky (a retry passed)
  deterministic: boolean | null;
}

// ---------------------------------------------------------------------------
// Low-level HTTP call — reused for initial attempt and retries
// ---------------------------------------------------------------------------

async function fireRequest(request: CauseStatementRequest): Promise<{
  response: CauseStatementResponse | null;
  httpStatus: number | null;
  latencyMs: number;
  failed: boolean;
  failReason: string | null;
  errorMessage?: string;
}> {
  const t0 = Date.now();
  try {
    const { data, status } = await axios.post<CauseStatementResponse>(BASE_URL, request, {
      headers: { Authorization: `${JWT_TOKEN}`, "Content-Type": "application/json" },
    });
    const latencyMs = Date.now() - t0;
    const textEmpty = !data.text || data.text.trim() === "";
    const failed = data.generated === false || textEmpty;
    const failReason = failed
      ? [data.generated === false ? "generated=false" : "", textEmpty ? "empty text" : ""]
          .filter(Boolean)
          .join(", ")
      : null;
    return { response: data, httpStatus: status, latencyMs, failed, failReason };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const axiosErr = err as AxiosError;
    const status = axiosErr.response?.status ?? null;
    return {
      response: null,
      httpStatus: status,
      latencyMs,
      failed: true,
      failReason: `HTTP error ${status ?? "network"}`,
      errorMessage: axiosErr.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Request execution (with retries on failure)
// ---------------------------------------------------------------------------

async function runRequest(
  combo: Combination,
  taskIndex: number,
  total: number,
  run: number
): Promise<RunResult> {
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

  const runTag = RUNS_PER_COMBO > 1 ? ` #${run}` : "";
  const label =
    `[${String(taskIndex + 1).padStart(String(total).length, " ")}/${total}]${runTag}` +
    ` ${combo.FUNDRAISER_ORGANIZATION_TYPE} › ${combo.FUNDRAISER_ACTIVITY}` +
    (combo.FUNDRAISER_AFFILIATION ? ` › ${combo.FUNDRAISER_AFFILIATION}` : "");

  const initial = await fireRequest(request);

  if (!initial.failed) {
    console.log(`  ✓ ${label}  (${initial.latencyMs}ms)`);
    return {
      combination: combo, request,
      response: initial.response, httpStatus: initial.httpStatus, latencyMs: initial.latencyMs,
      failed: false, failReason: null, retries: [], deterministic: null,
    };
  }

  // Failed — retry with the exact same payload to classify deterministic vs flaky
  const retries: RetryAttempt[] = [];
  for (let i = 0; i < RETRY_ON_FAIL; i++) {
    const r = await fireRequest(request);
    retries.push({ response: r.response, httpStatus: r.httpStatus, latencyMs: r.latencyMs, failed: r.failed });
  }
  const deterministic = retries.every((r) => r.failed);
  const cls = deterministic ? "DETERMINISTIC" : "FLAKY";
  console.log(`  ✗ ${label}  (${initial.latencyMs}ms)  ← ${initial.failReason}  [${cls}]`);

  return {
    combination: combo, request,
    response: initial.response, httpStatus: initial.httpStatus, latencyMs: initial.latencyMs,
    failed: true, failReason: initial.failReason, errorMessage: initial.errorMessage,
    retries, deterministic,
  };
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

interface Task { combo: Combination; taskIndex: number; total: number; run: number; }

async function runWithConcurrency(tasks: Task[], concurrency: number): Promise<RunResult[]> {
  const results: RunResult[] = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const { combo, taskIndex, total, run } = tasks[idx++];
      results.push(await runRequest(combo, taskIndex, total, run));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Failure breakdown analysis
// ---------------------------------------------------------------------------

function failureBreakdown(
  results: RunResult[],
  key: (r: RunResult) => string,
  label: string
): void {
  const map = new Map<string, { total: number; failed: number }>();
  for (const r of results) {
    const k = key(r);
    const e = map.get(k) ?? { total: 0, failed: 0 };
    e.total++;
    if (r.failed) e.failed++;
    map.set(k, e);
  }
  const sorted = [...map.entries()]
    .filter(([, v]) => v.failed > 0)
    .sort((a, b) => b[1].failed / b[1].total - a[1].failed / a[1].total);
  if (sorted.length === 0) return;
  console.log(`\n${label}:`);
  for (const [name, { total, failed }] of sorted) {
    const pct = ((failed / total) * 100).toFixed(0);
    const bar = "█".repeat(Math.round((failed / total) * 20)).padEnd(20);
    console.log(`  ${bar} ${pct.padStart(3)}%  ${failed}/${total}  ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const combos = buildCombinations();
  const tasks: Task[] = combos.flatMap((combo, i) =>
    Array.from({ length: RUNS_PER_COMBO }, (_, run) => ({
      combo,
      taskIndex: i * RUNS_PER_COMBO + run,
      total: combos.length * RUNS_PER_COMBO,
      run: run + 1,
    }))
  );

  console.log(`\nAI Cause Statement Tester`);
  console.log(`Endpoint      : ${BASE_URL}`);
  console.log(`Combinations  : ${combos.length}`);
  console.log(`Runs/combo    : ${RUNS_PER_COMBO}  →  ${tasks.length} total requests`);
  console.log(`Retries/fail  : ${RETRY_ON_FAIL}`);
  console.log(`Concurrency   : ${CONCURRENCY}\n`);

  const startedAt = Date.now();
  const results = await runWithConcurrency(tasks, CONCURRENCY);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  // --- Summary ---
  const failed = results.filter((r) => r.failed);
  const passed = results.length - failed.length;
  const deterministic = failed.filter((r) => r.deterministic === true);
  const flaky = failed.filter((r) => r.deterministic === false);
  const rate = ((failed.length / results.length) * 100).toFixed(1);
  const latencies = results.map((r) => r.latencyMs);
  const avgLatency = (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0);
  const minLatency = Math.min(...latencies);
  const maxLatency = Math.max(...latencies);
  const p95Latency = latencies.slice().sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)];

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Results`);
  console.log(`${"─".repeat(60)}`);
  console.log(`  Total            : ${results.length}`);
  console.log(`  Passed           : ${passed}`);
  console.log(`  Failed           : ${failed.length} (${rate}%)`);
  console.log(`  ├ Deterministic  : ${deterministic.length}  (all ${RETRY_ON_FAIL} retries also failed)`);
  console.log(`  └ Flaky          : ${flaky.length}  (passed on at least one retry)`);
  console.log(`  Time             : ${elapsed}s`);
  console.log(`  Latency          : avg ${avgLatency}ms  min ${minLatency}ms  max ${maxLatency}ms  p95 ${p95Latency}ms`);

  failureBreakdown(results, (r) => r.combination.FUNDRAISER_ORGANIZATION_TYPE, "Failures by organization type");
  failureBreakdown(results, (r) => r.combination.FUNDRAISER_ACTIVITY, "Failures by activity");
  failureBreakdown(
    results.filter((r) => !!r.combination.FUNDRAISER_AFFILIATION),
    (r) => r.combination.FUNDRAISER_AFFILIATION!,
    "Failures by affiliation"
  );

  if (failed.length > 0) {
    console.log(`\nFailed combinations:`);
    for (const r of failed) {
      const c = r.combination;
      const name =
        `${c.FUNDRAISER_ORGANIZATION_TYPE} › ${c.FUNDRAISER_ACTIVITY}` +
        (c.FUNDRAISER_AFFILIATION ? ` › ${c.FUNDRAISER_AFFILIATION}` : "");
      const cls = r.deterministic === true ? " [DETERMINISTIC]" : r.deterministic === false ? " [FLAKY]" : "";
      console.log(`  ✗  ${name}  [${r.failReason}]${cls}`);
    }
  }

  // --- Save results file ---
  const resultsDir = path.join(process.cwd(), "results");
  fs.mkdirSync(resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(resultsDir, `run-${timestamp}.json`);

  const meta = {
    runAt: new Date().toISOString(),
    endpoint: BASE_URL,
    combinationsCount: combos.length,
    runsPerCombo: RUNS_PER_COMBO,
    retriesOnFail: RETRY_ON_FAIL,
    total: results.length,
    passed,
    failed: failed.length,
    deterministic: deterministic.length,
    flaky: flaky.length,
    failureRate: `${rate}%`,
    elapsedSeconds: parseFloat(elapsed),
    latency: {
      avgMs: parseInt(avgLatency),
      minMs: minLatency,
      maxMs: maxLatency,
      p95Ms: p95Latency,
    },
  };

  fs.writeFileSync(outPath, JSON.stringify({ meta, failures: failed, all: results }, null, 2));

  // --- Failures-only JSON (full payloads for Postman/curl investigation) ---
  const failPath = path.join(resultsDir, `failures-${timestamp}.json`);
  fs.writeFileSync(failPath, JSON.stringify({ meta, failures: failed }, null, 2));

  // --- Write CSV ---
  const csvPath = path.join(resultsDir, `run-${timestamp}.csv`);
  const f = (v: string | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csvHeader = [
    "organization_type", "activity", "affiliation",
    "event_name", "org_name", "tags",
    "http_status", "latency_ms", "generated",
    "failed", "deterministic", "fail_reason", "text",
  ].join(",");

  const csvRows = results.map((r) =>
    [
      f(r.combination.FUNDRAISER_ORGANIZATION_TYPE),
      f(r.combination.FUNDRAISER_ACTIVITY),
      f(r.combination.FUNDRAISER_AFFILIATION),
      f(r.request.template.replaceable_attributes.FUNDRAISING_EVENT_NAME),
      f(r.request.template.replaceable_attributes.FUNDRAISER_ORGANIZATION_NAME),
      f(r.request.tags.join("|")),
      r.httpStatus ?? "",
      r.latencyMs,
      r.response?.generated ?? "",
      r.failed,
      r.deterministic ?? "",
      f(r.failReason),
      f(r.response?.text),
    ].join(",")
  );

  fs.writeFileSync(csvPath, [csvHeader, ...csvRows].join("\n"));

  console.log(`\nResults saved  → ${path.relative(process.cwd(), outPath)}`);
  console.log(`Failures saved → ${path.relative(process.cwd(), failPath)}`);
  console.log(`CSV saved      → ${path.relative(process.cwd(), csvPath)}\n`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
