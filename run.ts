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
const FLAKINESS_RUNS = parseInt(process.env.FLAKINESS_RUNS ?? "3", 10);

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

const CATEGORY_KEY_MAP: Record<string, string> = {
  "Arts & Culture": "ARTS",
  "Associations, Clubs & Community": "COMMUNITY",
  "Education & Academics": "EDUCATION",
  "Health & Wellness": "HEALTH",
  "Religious Organization": "RELIGIOUS",
  "Sororities & Fraternities": "GREEK",
  "Sports & Athletics": "SPORTS",
  "Other": "OTHER",
  "Personal": "PERSONAL",
};

function loadCategoryNames(field: "EVENT" | "ORG"): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const [orgType, slug] of Object.entries(CATEGORY_KEY_MAP)) {
    const key = `${field}_NAMES_${slug}`;
    const raw = process.env[key];
    if (!raw || raw.trim() === "") {
      console.error(`ERROR: ${key} is not set in .env`);
      process.exit(1);
    }
    const values = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (values.length === 0) {
      console.error(`ERROR: ${key} is empty in .env`);
      process.exit(1);
    }
    map[orgType] = values;
  }
  return map;
}

const EVENT_NAMES_BY_CATEGORY = loadCategoryNames("EVENT");
const ORG_NAMES_BY_CATEGORY = loadCategoryNames("ORG");

const ALL_TAGS = Object.values(CauseTag);

function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function categoryPick(orgType: string, field: "EVENT" | "ORG"): string {
  const map = field === "EVENT" ? EVENT_NAMES_BY_CATEGORY : ORG_NAMES_BY_CATEGORY;
  const list = map[orgType] ?? map["Other"];
  return randomPick(list);
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

type FlakLabel = "stable" | "flaky" | "deterministic";

interface Attempt {
  response: CauseStatementResponse | null;
  httpStatus: number | null;
  latencyMs: number;
  failed: boolean;
  failReason: string | null;
  errorMessage?: string;
}

interface IsolationVariant {
  variant: string; // e.g. "minimal", "all-tags", "fixed-names", "tag:Travel"
  tags: CauseTag[];
  eventName?: string;
  orgName?: string;
  attempts: Attempt[];
  flakRate: number;
  flakLabel: FlakLabel;
}

interface RunResult {
  combination: Combination;
  request: CauseStatementRequest;
  // allAttempts: all FLAKINESS_RUNS attempts with the same payload
  allAttempts: Attempt[];
  flakRate: number;           // 0.0 – 1.0
  flakLabel: FlakLabel;
  // Convenience fields from the first attempt:
  response: CauseStatementResponse | null;
  httpStatus: number | null;
  latencyMs: number;
  failed: boolean;            // true if ANY attempt failed (flakRate > 0)
  failReason: string | null;
  // Only populated for combos with flakRate > 0:
  isolationResults: IsolationVariant[];
}

// ---------------------------------------------------------------------------
// Low-level HTTP call
// ---------------------------------------------------------------------------

async function fireRequest(request: CauseStatementRequest): Promise<Attempt> {
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

/** Fire the same payload FLAKINESS_RUNS times and compute flakRate + flakLabel. */
async function fireMany(request: CauseStatementRequest): Promise<{
  attempts: Attempt[];
  flakRate: number;
  flakLabel: FlakLabel;
}> {
  const attempts: Attempt[] = [];
  for (let i = 0; i < FLAKINESS_RUNS; i++) {
    attempts.push(await fireRequest(request));
  }
  const failCount = attempts.filter((a) => a.failed).length;
  const flakRate = failCount / attempts.length;
  const flakLabel: FlakLabel =
    flakRate === 0 ? "stable" : flakRate === 1 ? "deterministic" : "flaky";
  return { attempts, flakRate, flakLabel };
}

// ---------------------------------------------------------------------------
// Isolation testing
// ---------------------------------------------------------------------------

const ISOLATION_VARIANTS: Array<{ variant: string; tags: CauseTag[]; eventName?: string; orgName?: string }> = [
  { variant: "minimal",     tags: [CauseTag.Event] },
  { variant: "all-tags",    tags: ALL_TAGS },
  { variant: "fixed-names", tags: ALL_TAGS, eventName: "Annual Fundraiser", orgName: "Test Organization" },
  ...ALL_TAGS.map((tag) => ({ variant: `tag:${tag}`, tags: [tag] })),
];

async function runIsolation(combo: Combination): Promise<IsolationVariant[]> {
  const results: IsolationVariant[] = [];
  for (const v of ISOLATION_VARIANTS) {
    const request: CauseStatementRequest = {
      tags: v.tags,
      template: {
        replaceable_attributes: {
          FUNDRAISING_EVENT_NAME: v.eventName ?? categoryPick(combo.FUNDRAISER_ORGANIZATION_TYPE, "EVENT"),
          FUNDRAISER_ORGANIZATION_TYPE: combo.FUNDRAISER_ORGANIZATION_TYPE,
          FUNDRAISER_ACTIVITY: combo.FUNDRAISER_ACTIVITY,
          ...(combo.FUNDRAISER_AFFILIATION ? { FUNDRAISER_AFFILIATION: combo.FUNDRAISER_AFFILIATION } : {}),
          ...(v.orgName ? { FUNDRAISER_ORGANIZATION_NAME: v.orgName } : {}),
        },
      },
    };
    const { attempts, flakRate, flakLabel } = await fireMany(request);
    results.push({ variant: v.variant, tags: v.tags, eventName: v.eventName, orgName: v.orgName, attempts, flakRate, flakLabel });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Request execution — uniform FLAKINESS_RUNS per combo
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
        FUNDRAISING_EVENT_NAME: categoryPick(combo.FUNDRAISER_ORGANIZATION_TYPE, "EVENT"),
        FUNDRAISER_ORGANIZATION_NAME: categoryPick(combo.FUNDRAISER_ORGANIZATION_TYPE, "ORG"),
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

  const { attempts, flakRate, flakLabel } = await fireMany(request);
  const first = attempts[0];
  const anyFailed = flakRate > 0;

  const passCount = attempts.filter((a) => !a.failed).length;
  const icon = flakLabel === "stable" ? "✓" : flakLabel === "deterministic" ? "✗" : "⚠";
  const detail = anyFailed ? `  ← ${first.failReason ?? attempts.find((a) => a.failReason)?.failReason}  [${flakLabel.toUpperCase()} ${passCount}/${attempts.length} pass]` : "";
  console.log(`  ${icon} ${label}  (${first.latencyMs}ms)${detail}`);

  let isolationResults: IsolationVariant[] = [];
  if (anyFailed) {
    process.stdout.write(`    → running isolation tests for ${label.trim()}...`);
    isolationResults = await runIsolation(combo);
    const isoSummary = isolationResults
      .map((v) => `${v.variant}:${v.flakLabel === "stable" ? "✓" : v.flakLabel === "deterministic" ? "✗" : "⚠"}`)
      .join(" ");
    console.log(`\r    → isolation: ${isoSummary}`);
  }

  return {
    combination: combo,
    request,
    allAttempts: attempts,
    flakRate,
    flakLabel,
    response: first.response,
    httpStatus: first.httpStatus,
    latencyMs: first.latencyMs,
    failed: anyFailed,
    failReason: first.failReason ?? attempts.find((a) => a.failReason)?.failReason ?? null,
    isolationResults,
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

  const requestsPerCombo = FLAKINESS_RUNS;
  const isolationPerFailingCombo = ISOLATION_VARIANTS.length * FLAKINESS_RUNS;
  console.log(`\nAI Cause Statement Tester`);
  console.log(`Endpoint         : ${BASE_URL}`);
  console.log(`Combinations     : ${combos.length}`);
  console.log(`Runs/combo       : ${RUNS_PER_COMBO}  →  ${tasks.length} combos to test`);
  console.log(`Flakiness runs   : ${requestsPerCombo}  (same payload fired N times per combo)`);
  console.log(`Isolation tests  : ${ISOLATION_VARIANTS.length} variants × ${FLAKINESS_RUNS} runs each (only for failing combos)`);
  console.log(`Concurrency      : ${CONCURRENCY}\n`);

  const startedAt = Date.now();
  const results = await runWithConcurrency(tasks, CONCURRENCY);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  // --- Summary ---
  const failed = results.filter((r) => r.failed);
  const passed = results.length - failed.length;
  const deterministic = results.filter((r) => r.flakLabel === "deterministic");
  const flaky = results.filter((r) => r.flakLabel === "flaky");
  const stable = results.filter((r) => r.flakLabel === "stable");
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
  console.log(`  ✓ Stable         : ${stable.length}`);
  console.log(`  ⚠ Flaky          : ${flaky.length}  (fails sometimes — infra issue)`);
  console.log(`  ✗ Deterministic  : ${deterministic.length}  (always fails — prompt/taxonomy bug)`);
  console.log(`  Failed ≥ once    : ${failed.length} (${rate}%)`);
  console.log(`  Time             : ${elapsed}s`);
  console.log(`  Latency          : avg ${avgLatency}ms  min ${minLatency}ms  max ${maxLatency}ms  p95 ${p95Latency}ms`);

  failureBreakdown(results, (r) => r.combination.FUNDRAISER_ORGANIZATION_TYPE, "Failures by organization type");
  failureBreakdown(results, (r) => r.combination.FUNDRAISER_ACTIVITY, "Failures by activity");
  failureBreakdown(
    results.filter((r) => !!r.combination.FUNDRAISER_AFFILIATION),
    (r) => r.combination.FUNDRAISER_AFFILIATION!,
    "Failures by affiliation"
  );

  // --- Isolation summary for deterministic combos ---
  if (deterministic.length > 0) {
    console.log(`\nDeterministic isolation results:`);
    for (const r of deterministic) {
      const name = `${r.combination.FUNDRAISER_ORGANIZATION_TYPE} › ${r.combination.FUNDRAISER_ACTIVITY}` +
        (r.combination.FUNDRAISER_AFFILIATION ? ` › ${r.combination.FUNDRAISER_AFFILIATION}` : "");
      console.log(`  ${name}`);
      for (const v of r.isolationResults) {
        const icon = v.flakLabel === "stable" ? "✓" : v.flakLabel === "deterministic" ? "✗" : "⚠";
        const pct = (v.flakRate * 100).toFixed(0);
        console.log(`    ${icon} ${v.variant.padEnd(20)} fail ${pct}%`);
      }
    }
  }

  if (failed.length > 0) {
    console.log(`\nAll failing combinations:`);
    for (const r of failed) {
      const c = r.combination;
      const name = `${c.FUNDRAISER_ORGANIZATION_TYPE} › ${c.FUNDRAISER_ACTIVITY}` +
        (c.FUNDRAISER_AFFILIATION ? ` › ${c.FUNDRAISER_AFFILIATION}` : "");
      const passCount = r.allAttempts.filter((a) => !a.failed).length;
      console.log(`  ${r.flakLabel === "deterministic" ? "✗" : "⚠"}  ${name}  [${r.flakLabel.toUpperCase()} ${passCount}/${r.allAttempts.length} pass]  [${r.failReason}]`);
    }
  }

  // --- Save files ---
  const resultsDir = path.join(process.cwd(), "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  const meta = {
    runAt: new Date().toISOString(),
    endpoint: BASE_URL,
    combinationsCount: combos.length,
    runsPerCombo: RUNS_PER_COMBO,
    flakinessRuns: FLAKINESS_RUNS,
    isolationVariants: ISOLATION_VARIANTS.length,
    total: results.length,
    stable: stable.length,
    flaky: flaky.length,
    deterministic: deterministic.length,
    failedAtLeastOnce: failed.length,
    failureRate: `${rate}%`,
    elapsedSeconds: parseFloat(elapsed),
    latency: { avgMs: parseInt(avgLatency), minMs: minLatency, maxMs: maxLatency, p95Ms: p95Latency },
  };

  const outPath = path.join(resultsDir, `run-${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ meta, failures: failed, all: results }, null, 2));

  const failPath = path.join(resultsDir, `failures-${timestamp}.json`);
  fs.writeFileSync(failPath, JSON.stringify({ meta, failures: failed }, null, 2));

  // --- CSV: one row per combo ---
  const csvPath = path.join(resultsDir, `run-${timestamp}.csv`);
  const q = (v: string | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csvHeader = [
    "organization_type", "activity", "affiliation",
    "event_name", "org_name", "tags",
    "http_status", "latency_ms",
    "flak_label", "flak_rate", "attempts_total", "attempts_failed",
    "fail_reason", "first_response_text",
    // one column per isolation variant
    ...ISOLATION_VARIANTS.map((v) => `iso:${v.variant}`),
  ].join(",");

  const csvRows = results.map((r) => {
    const attFailed = r.allAttempts.filter((a) => a.failed).length;
    const isoValues = ISOLATION_VARIANTS.map((v) => {
      const iso = r.isolationResults.find((x) => x.variant === v.variant);
      return iso ? `${(iso.flakRate * 100).toFixed(0)}%` : "";
    });
    return [
      q(r.combination.FUNDRAISER_ORGANIZATION_TYPE),
      q(r.combination.FUNDRAISER_ACTIVITY),
      q(r.combination.FUNDRAISER_AFFILIATION),
      q(r.request.template.replaceable_attributes.FUNDRAISING_EVENT_NAME),
      q(r.request.template.replaceable_attributes.FUNDRAISER_ORGANIZATION_NAME),
      q(r.request.tags.join("|")),
      r.httpStatus ?? "",
      r.latencyMs,
      r.flakLabel,
      (r.flakRate * 100).toFixed(0) + "%",
      r.allAttempts.length,
      attFailed,
      q(r.failReason),
      q(r.response?.text),
      ...isoValues,
    ].join(",");
  });

  fs.writeFileSync(csvPath, [csvHeader, ...csvRows].join("\n"));

  console.log(`\nResults saved  → ${path.relative(process.cwd(), outPath)}`);
  console.log(`Failures saved → ${path.relative(process.cwd(), failPath)}`);
  console.log(`CSV saved      → ${path.relative(process.cwd(), csvPath)}\n`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
