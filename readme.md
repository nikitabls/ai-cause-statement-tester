# AI Cause Statement Tester

A CLI tool for stress-testing the Double Good cause statement generation endpoint. It exhaustively tests every taxonomy combination, measures flakiness, runs isolation tests on failing combos to identify root causes, and outputs structured JSON and CSV results for analysis.

---

## Setup

```sh
npm install
cp .env.example .env
# Fill in JWT_TOKEN and USER_UUID in .env
```

### `.env` variables

| Variable | Default | Description |
|---|---|---|
| `JWT_TOKEN` | — | **Required.** Bearer token (without the `Bearer ` prefix) |
| `USER_UUID` | — | **Required.** User UUID used in the endpoint path |
| `CONCURRENCY` | `5` | Number of combination-level requests to run in parallel |
| `RUNS_PER_COMBO` | `1` | How many times to run each combo with **fresh random inputs** |
| `FLAKINESS_RUNS` | `3` | How many times to fire the **same payload** per combo to measure flakiness |

---

## Scripts

### `npm start` — Run the test suite

```sh
npm start
# or with overrides:
FLAKINESS_RUNS=5 CONCURRENCY=10 npm start
```

Fires every leaf combination from `taxonomy.data.ts` against:

```
POST https://api.test-004.doublegood.com/ai-assistant/users/{USER_UUID}/text-generation/cause
```

**What it does per combination:**

1. Builds a `CauseStatementRequest` with random tags, event name, and org name
2. Fires the **same payload** `FLAKINESS_RUNS` times to measure flakiness
3. Classifies each combo as `stable`, `flaky`, or `deterministic` (see below)
4. For any combo that had at least one failure, runs **12 isolation variants** × `FLAKINESS_RUNS` to identify root cause

**Console output:**

```
  ✓ [001/176] Arts & Culture › Band › High School  (843ms)
  ⚠ [009/176] Arts & Culture › Music  (1163ms)  ← generated=false, empty text  [FLAKY 2/3 pass]
    → isolation: minimal:✓ all-tags:✓ fixed-names:✓ tag:Travel:✓ tag:Other:⚠ ...
  ✗ [042/176] Education & Academics › Student Council  (1200ms)  ← ...  [DETERMINISTIC 0/3 pass]
```

**Output files** (written to `results/`):

| File | Contents |
|---|---|
| `run-{timestamp}.json` | Full results — `meta` summary + `failures[]` + `all[]` |
| `failures-{timestamp}.json` | Failures only — complete payloads ready for Postman/curl |
| `run-{timestamp}.csv` | One row per combo with flakiness stats + per-isolation-variant fail rates |

---

### `npx tsx analyze.ts` — Cross-run aggregation

```sh
npx tsx analyze.ts
```

Reads **all** `results/run-*.json` files and produces a combined analysis. Use after multiple runs to build statistical confidence.

**Outputs:**

1. **Per-combo aggregate fail rate** — with `low / medium / high` confidence based on number of runs, plus aggregated isolation variant breakdown
2. **Tag correlation table** — fail rate per `CauseTag` vs global baseline (surfaces if specific tags are disproportionately involved in failures)
3. **Latency anomaly detection** — combos with median latency > 2× the global median
4. `results/analysis-{timestamp}.csv` — all per-combo stats with per-isolation-variant columns

---

## How flakiness classification works

Each combination is fired `FLAKINESS_RUNS` times with the **exact same payload**.

| `flakLabel` | Condition | Meaning |
|---|---|---|
| `stable` | 0% of attempts failed | Consistently passes |
| `flaky` | 1–99% of attempts failed | Intermittent — likely an infrastructure/LLM inference issue |
| `deterministic` | 100% of attempts failed | Always fails — likely a prompt or taxonomy bug |

A response is classified as **failed** if `generated === false` OR `text` is empty/whitespace.

---

## How isolation testing works

For any combo with `flakRate > 0`, the tool automatically fires 12 controlled variants to narrow down root cause:

| Variant | Tags | Event name | Org name | Answers |
|---|---|---|---|---|
| `minimal` | `[Event]` | none | none | Does the taxonomy combo itself fail? |
| `all-tags` | all 9 tags | none | none | Does the tag count/mix matter? |
| `fixed-names` | all 9 tags | `"Annual Fundraiser"` | `"Test Organization"` | Do specific entity names affect it? |
| `tag:Travel` | `[Travel]` | none | none | Is this specific tag the trigger? |
| `tag:Fees` | `[Fees]` | none | none | ↑ same for each of the 9 tags |
| … | … | … | … | |

**Reading isolation results:**

- `minimal` fails → the taxonomy combination itself is broken (prompt-level bug)
- `minimal` passes but `all-tags` fails → too many tags overwhelm the prompt
- `minimal` passes but `tag:X` fails → tag `X` specifically causes the failure
- Everything passes → the original failure was caused by the randomized entity names

---

## Taxonomy coverage

The tool generates **176 combinations** from `taxonomy.data.ts`:

| Category | Combos |
|---|---|
| Sports & Athletics | 79 |
| Sororities & Fraternities | 13 |
| Education & Academics | 22 |
| Arts & Culture | 16 |
| Associations, Clubs & Community | 17 |
| Health & Wellness | 7 |
| Religious Organization | 5 |
| Other / Personal | 0 (no activities) |

Each activity with affiliations produces one combination per affiliation. Activities without affiliations produce one combination with no affiliation field.

---

## Project structure

```
run.ts                  Main test runner
analyze.ts              Cross-run aggregation and analysis
taxonomy.data.ts        Taxonomy categories, activities, and affiliations
request.interface.ts    CauseStatementRequest type + CauseTag enum
response.interface.ts   CauseStatementResponse type
.env.example            Template for required env vars
results/
  run-*.json            Full run output
  failures-*.json       Failures-only output
  run-*.csv             Per-combo CSV with isolation columns
  analysis-*.csv        Cross-run aggregation CSV
```

---

## Interpreting results

**High flaky rate with short retry latency** → Server-side intermittency. A simple retry in the production client would resolve most failures. From the first run: flaky failures had avg initial latency of 1309ms vs 663ms on retry — the first attempt appears to hit a cold or overloaded path.

**Deterministic failures** → Prompt or taxonomy bug. Check isolation results: if `minimal` also fails, the issue is the combination itself (activity/affiliation name not handled by the prompt). If only `all-tags` or a specific `tag:X` fails, the prompt doesn't handle that tag for that category.

**Latency anomalies** → Combos with consistently high latency may be causing server-side timeouts that manifest as empty responses.
