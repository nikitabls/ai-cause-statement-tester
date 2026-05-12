/**
 * analyze.ts — Cross-run aggregation
 * Reads all results/run-*.json files and produces:
 *   1. Per-combo aggregate fail rate across historical runs
 *   2. Tag correlation table (fail rate per CauseTag)
 *   3. Latency anomaly detection
 *   4. results/analysis-{timestamp}.csv
 *
 * Usage: npx tsx analyze.ts
 */

import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Types (mirrors run.ts output shapes)
// ---------------------------------------------------------------------------

interface Attempt {
  failed: boolean;
  latencyMs: number;
  failReason: string | null;
}

interface IsolationVariant {
  variant: string;
  tags: string[];
  flakRate: number;
  flakLabel: string;
  attempts: Attempt[];
}

interface RunResultRecord {
  combination: {
    FUNDRAISER_ORGANIZATION_TYPE: string;
    FUNDRAISER_ACTIVITY: string;
    FUNDRAISER_AFFILIATION?: string;
  };
  request: {
    tags: string[];
    template: {
      replaceable_attributes: Record<string, string | undefined>;
    };
  };
  allAttempts: Attempt[];
  flakRate: number;
  flakLabel: string;
  latencyMs: number;
  failed: boolean;
  failReason: string | null;
  isolationResults: IsolationVariant[];
}

interface RunFile {
  meta: Record<string, unknown>;
  all: RunResultRecord[];
}

// ---------------------------------------------------------------------------
// Load all run files
// ---------------------------------------------------------------------------

const resultsDir = path.join(process.cwd(), "results");
const runFiles = fs
  .readdirSync(resultsDir)
  .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
  .sort();

if (runFiles.length === 0) {
  console.error("No run-*.json files found in results/");
  process.exit(1);
}

console.log(`\nAnalyzing ${runFiles.length} run file(s):\n`);
runFiles.forEach((f) => console.log(`  ${f}`));
console.log();

const allRecords: RunResultRecord[] = [];
for (const file of runFiles) {
  const raw = JSON.parse(fs.readFileSync(path.join(resultsDir, file), "utf8")) as RunFile;
  if (Array.isArray(raw.all)) {
    allRecords.push(...raw.all);
  }
}

console.log(`Total records loaded: ${allRecords.length}\n`);

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const comboKey = (r: RunResultRecord) =>
  [
    r.combination.FUNDRAISER_ORGANIZATION_TYPE,
    r.combination.FUNDRAISER_ACTIVITY,
    r.combination.FUNDRAISER_AFFILIATION ?? "",
  ].join(" › ");

function pct(n: number, d: number) {
  return d === 0 ? "–" : ((n / d) * 100).toFixed(1) + "%";
}

function avg(arr: number[]) {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr: number[]) {
  if (arr.length === 0) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// ---------------------------------------------------------------------------
// 1. Per-combo aggregate fail rate
// ---------------------------------------------------------------------------

interface ComboStats {
  key: string;
  orgType: string;
  activity: string;
  affiliation: string;
  totalRuns: number;
  totalAttempts: number;
  failedAttempts: number;
  flakRate: number;          // fraction of individual attempts that failed
  runsFailed: number;        // runs where flakLabel !== "stable"
  runsStable: number;
  runsFlaky: number;
  runsDeterministic: number;
  confidence: "low" | "medium" | "high";
  latencies: number[];
  medianLatencyMs: number;
  // iso results aggregated across runs
  isoVariants: Map<string, { failCount: number; totalAttempts: number }>;
}

const comboMap = new Map<string, ComboStats>();

for (const r of allRecords) {
  const key = comboKey(r);
  if (!comboMap.has(key)) {
    comboMap.set(key, {
      key,
      orgType: r.combination.FUNDRAISER_ORGANIZATION_TYPE,
      activity: r.combination.FUNDRAISER_ACTIVITY,
      affiliation: r.combination.FUNDRAISER_AFFILIATION ?? "",
      totalRuns: 0,
      totalAttempts: 0,
      failedAttempts: 0,
      flakRate: 0,
      runsFailed: 0,
      runsStable: 0,
      runsFlaky: 0,
      runsDeterministic: 0,
      confidence: "low",
      latencies: [],
      medianLatencyMs: 0,
      isoVariants: new Map(),
    });
  }
  const s = comboMap.get(key)!;
  s.totalRuns++;
  // allAttempts may be missing in old run files; fall back to single attempt
  const attempts: Attempt[] = r.allAttempts?.length
    ? r.allAttempts
    : [{ failed: r.failed, latencyMs: r.latencyMs, failReason: r.failReason }];
  s.totalAttempts += attempts.length;
  s.failedAttempts += attempts.filter((a) => a.failed).length;
  s.latencies.push(r.latencyMs);
  if (r.flakLabel === "stable" || !r.failed) s.runsStable++;
  else if (r.flakLabel === "flaky") s.runsFlaky++;
  else if (r.flakLabel === "deterministic") s.runsDeterministic++;
  else if (r.failed) s.runsFailed++;

  // Aggregate isolation results
  for (const iso of r.isolationResults ?? []) {
    const existing = s.isoVariants.get(iso.variant) ?? { failCount: 0, totalAttempts: 0 };
    const isoAttempts = iso.attempts ?? [];
    existing.totalAttempts += isoAttempts.length;
    existing.failCount += isoAttempts.filter((a) => a.failed).length;
    s.isoVariants.set(iso.variant, existing);
  }
}

// Compute derived stats
for (const s of comboMap.values()) {
  s.flakRate = s.totalAttempts > 0 ? s.failedAttempts / s.totalAttempts : 0;
  s.medianLatencyMs = median(s.latencies);
  s.confidence = s.totalRuns >= 5 ? "high" : s.totalRuns >= 3 ? "medium" : "low";
}

const sortedCombos = [...comboMap.values()].sort((a, b) => b.flakRate - a.flakRate);

// ---------------------------------------------------------------------------
// 2. Tag correlation
// ---------------------------------------------------------------------------

interface TagStats {
  tag: string;
  totalAppearances: number;
  failedAttempts: number;
  passedAttempts: number;
  failRate: number;
}

const tagMap = new Map<string, { totalAttempts: number; failedAttempts: number }>();

for (const r of allRecords) {
  const tags = r.request?.tags ?? [];
  const attempts: Attempt[] = r.allAttempts?.length
    ? r.allAttempts
    : [{ failed: r.failed, latencyMs: r.latencyMs, failReason: r.failReason }];
  const attFailed = attempts.filter((a) => a.failed).length;

  for (const tag of tags) {
    const e = tagMap.get(tag) ?? { totalAttempts: 0, failedAttempts: 0 };
    e.totalAttempts += attempts.length;
    e.failedAttempts += attFailed;
    tagMap.set(tag, e);
  }
}

const tagStats: TagStats[] = [...tagMap.entries()]
  .map(([tag, v]) => ({
    tag,
    totalAppearances: v.totalAttempts,
    failedAttempts: v.failedAttempts,
    passedAttempts: v.totalAttempts - v.failedAttempts,
    failRate: v.totalAttempts > 0 ? v.failedAttempts / v.totalAttempts : 0,
  }))
  .sort((a, b) => b.failRate - a.failRate);

// ---------------------------------------------------------------------------
// 3. Latency anomalies
// ---------------------------------------------------------------------------

const globalMedianLatency = median(allRecords.map((r) => r.latencyMs));
const LATENCY_ANOMALY_THRESHOLD = 2.0;

const latencyAnomalies = sortedCombos
  .filter((s) => s.medianLatencyMs > globalMedianLatency * LATENCY_ANOMALY_THRESHOLD)
  .sort((a, b) => b.medianLatencyMs - a.medianLatencyMs);

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------

const SEP = "─".repeat(70);

// --- Per-combo ---
console.log(SEP);
console.log("Per-Combo Aggregate Failure Rate");
console.log(SEP);
const failingCombos = sortedCombos.filter((s) => s.flakRate > 0);
if (failingCombos.length === 0) {
  console.log("  No failures found across all runs.");
} else {
  for (const s of failingCombos) {
    const bar = "█".repeat(Math.round(s.flakRate * 20)).padEnd(20);
    const label =
      s.runsDeterministic > 0 ? "DETERMINISTIC" : s.runsFlaky > 0 ? "FLAKY" : "FAILED";
    const conf = `[${s.confidence} confidence, ${s.totalRuns} run${s.totalRuns > 1 ? "s" : ""}]`;
    console.log(
      `  ${bar} ${pct(s.failedAttempts, s.totalAttempts).padStart(6)}  ${label.padEnd(14)} ${s.key}  ${conf}`
    );
    // Show isolation breakdown if available
    if (s.isoVariants.size > 0) {
      for (const [variant, iv] of s.isoVariants.entries()) {
        if (iv.totalAttempts === 0) continue;
        const isoRate = iv.failCount / iv.totalAttempts;
        const icon = isoRate === 0 ? "✓" : isoRate === 1 ? "✗" : "⚠";
        console.log(
          `    ${icon} iso:${variant.padEnd(22)} ${pct(iv.failCount, iv.totalAttempts).padStart(6)} fail`
        );
      }
    }
  }
}

// --- Tag correlation ---
console.log(`\n${SEP}`);
console.log("Tag Correlation (fail rate per tag across all attempts)");
console.log(SEP);
const globalFailRate = allRecords.reduce((acc, r) => {
  const attempts = r.allAttempts?.length ?? 1;
  const failed = r.allAttempts?.filter((a) => a.failed).length ?? (r.failed ? 1 : 0);
  return acc + failed / attempts;
}, 0) / allRecords.length;

console.log(`  Global fail rate: ${pct(
  allRecords.reduce((a, r) => a + (r.allAttempts?.filter((x) => x.failed).length ?? (r.failed ? 1 : 0)), 0),
  allRecords.reduce((a, r) => a + (r.allAttempts?.length ?? 1), 0)
)}`);
console.log();
for (const t of tagStats) {
  const bar = "█".repeat(Math.round(t.failRate * 20)).padEnd(20);
  const delta = t.failRate - globalFailRate;
  const deltaStr = (delta >= 0 ? "+" : "") + (delta * 100).toFixed(1) + "% vs global";
  console.log(`  ${bar} ${pct(t.failedAttempts, t.totalAppearances).padStart(6)}  ${t.tag.padEnd(14)} ${deltaStr}`);
}

// --- Latency anomalies ---
console.log(`\n${SEP}`);
console.log(`Latency Anomalies (median > ${LATENCY_ANOMALY_THRESHOLD}× global median of ${globalMedianLatency}ms)`);
console.log(SEP);
if (latencyAnomalies.length === 0) {
  console.log("  None detected.");
} else {
  for (const s of latencyAnomalies) {
    const ratio = (s.medianLatencyMs / globalMedianLatency).toFixed(1);
    console.log(`  ${String(s.medianLatencyMs).padStart(6)}ms median  (${ratio}×)  ${s.key}`);
  }
}

// ---------------------------------------------------------------------------
// CSV output
// ---------------------------------------------------------------------------

const allIsoVariants = [...new Set(allRecords.flatMap((r) => (r.isolationResults ?? []).map((v) => v.variant)))].sort();

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = path.join(resultsDir, `analysis-${timestamp}.csv`);

const q = (v: string | number | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;

const csvHeader = [
  "organization_type", "activity", "affiliation",
  "total_runs", "total_attempts", "failed_attempts",
  "flak_rate_pct", "confidence",
  "runs_stable", "runs_flaky", "runs_deterministic",
  "median_latency_ms",
  ...allIsoVariants.map((v) => `iso_failrate:${v}`),
].join(",");

const csvRows = sortedCombos.map((s) => {
  const isoValues = allIsoVariants.map((v) => {
    const iv = s.isoVariants.get(v);
    if (!iv || iv.totalAttempts === 0) return "";
    return ((iv.failCount / iv.totalAttempts) * 100).toFixed(1) + "%";
  });
  return [
    q(s.orgType), q(s.activity), q(s.affiliation),
    s.totalRuns, s.totalAttempts, s.failedAttempts,
    ((s.flakRate) * 100).toFixed(1) + "%", s.confidence,
    s.runsStable, s.runsFlaky, s.runsDeterministic,
    s.medianLatencyMs,
    ...isoValues,
  ].join(",");
});

fs.writeFileSync(outPath, [csvHeader, ...csvRows].join("\n"));

console.log(`\nAnalysis CSV saved → ${path.relative(process.cwd(), outPath)}\n`);
