# AI Cause Statement Tester

This tool automatically tests whether the AI-generated cause statement feature works correctly across every fundraiser type in the app. It sends test requests to the API for all 176 combinations of organization type, activity, and affiliation, then tells you which ones always work, which ones sometimes fail, and which ones are completely broken — so the team can prioritize fixes.

---

## Before you start

You need **Node.js** installed on your computer. It's free software that runs this tool.

1. Go to [nodejs.org](https://nodejs.org) and download the **LTS** version (the one labeled "Recommended for most users")
2. Run the installer — click through all the defaults
3. To confirm it worked, open **Terminal** (on Mac: press `⌘ Space`, type `Terminal`, press Enter) and run:
   ```sh
   node --version
   ```
   You should see a version number like `v20.x.x`. If you do, you're ready.

---

## Step 1 — Get your credentials

The tool needs two values from a real app request: a **JWT token** (your login credential) and a **User UUID** (your account ID).

1. Open the Double Good mobile app on your device
2. Navigate to the cause statement screen and generate a cause statement
3. In the app's devtools (or using a tool like **Proxyman** or **Charles** on your Mac), find the network request that was just made
4. Tap **Share full request** (or copy the raw request)
5. From that request, copy:
   - The `Authorization` header value — it looks like `Bearer eyJhbGci...`. **Remove the word `Bearer ` from the front** — you only want the long string of letters and numbers after it. This is your `JWT_TOKEN`.
   - The URL will contain `/users/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/text-generation/cause` — the long ID in the middle is your `USER_UUID`.

Keep these values handy for Step 3.

---

## Step 2 — Open the project folder in Terminal

1. Open **Terminal**
2. Type `cd ` (with a space after it), then drag the project folder from Finder into the Terminal window. The folder path will appear automatically.
3. Press **Enter**

---

## Step 3 — Install dependencies

Run this once to download the packages the tool needs:

```sh
npm install
```

You'll see a progress log. Wait until it finishes and returns to the prompt.

---

## Step 4 — Create your config file

1. Run this command to create your personal config file:
   ```sh
   cp .env.example .env
   ```
2. Open the newly created `.env` file in any text editor (TextEdit, VS Code, etc.)
3. Fill in the two values you copied in Step 1:
   ```
   JWT_TOKEN=eyJhbGci...   ← paste your token here (no quotes, no "Bearer " prefix)
   USER_UUID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx   ← paste your UUID here
   ```
4. Save the file

> **Note:** The `.env` file is personal — it stays on your computer and is never shared or committed to version control.

---

## Step 5 — Run the tests

```sh
npm start
```

The tool will test all 176 combinations one by one. Each line in the console shows the result for one combination:

```
  ✓ [001/176] Arts & Culture › Band › High School  (843ms)
  ⚠ [009/176] Arts & Culture › Music  (1163ms)  [FLAKY 2/3 pass]
  ✗ [042/176] Education & Academics › Student Council  (1200ms)  [DETERMINISTIC 0/3 pass]
```

| Symbol | Meaning |
|---|---|
| `✓` | This combination always generated a cause statement successfully |
| `⚠` | This combination sometimes worked and sometimes didn't (intermittent) |
| `✗` | This combination always failed to generate a cause statement |

A full run takes roughly **5–15 minutes** depending on how many failures are found (failures trigger extra diagnostic tests automatically).

When it finishes, results are saved to the `results/` folder.

---

## Step 6 — Open your results

Open the `results/` folder. You'll see files named like:

- `run-2026-05-12T10-30-00.csv` — **open this one** in Spreadsheets APP
- `run-2026-05-12T10-30-00.json` — JSON format
- `failures-2026-05-12T10-30-00.json` — JSON format

To open the CSV in **Google Sheets**: go to [sheets.google.com](https://sheets.google.com) → File → Import → Upload the CSV file.

---

## Understanding the results — `run-*.csv` columns

Each row in this file represents one fundraiser type combination (e.g. "Sports & Athletics › Basketball › High School").

### What combination was tested

| Column | What it means |
|---|---|
| `organization_type` | The top-level fundraiser category (e.g. "Sports & Athletics", "Arts & Culture") |
| `activity` | The specific activity within that category (e.g. "Basketball", "Band") |
| `affiliation` | The school level or subgroup (e.g. "High School", "Middle School"); blank if not applicable for this activity |

### What inputs were used

| Column | What it means |
|---|---|
| `event_name` | The fundraiser name the tool made up for this test (e.g. "Spring Fundraiser") — randomized to make tests realistic |
| `org_name` | The organization name the tool made up for this test (e.g. "Lincoln High School") — randomized |
| `tags` | The fundraiser purpose tags included in this request (e.g. `Travel\|Fees\|Supplies`) — randomized |

### The verdict

| Column | What it means |
|---|---|
| `flak_label` | **The main result.** `stable` = always worked, `flaky` = sometimes failed, `deterministic` = always failed |
| `flak_rate` | Percentage of attempts that failed. `0%` = perfect, `100%` = completely broken |
| `attempts_total` | How many times this exact request was sent (matches the `FLAKINESS_RUNS` setting) |
| `attempts_failed` | How many of those attempts came back with an error or empty text |
| `fail_reason` | Why it failed, when it did — e.g. `"empty text"` (AI returned nothing) or `"generated=false"` (API said generation failed) |
| `first_response_text` | The actual AI-generated cause statement from the first attempt — useful to spot quality issues even on passing combinations |

### Technical details

| Column | What it means |
|---|---|
| `http_status` | Server response code: `200` means the server accepted the request; anything else (like `500`) means a server error before the AI even ran |
| `latency_ms` | How long the AI took to respond, in milliseconds (1 second = 1,000 ms). Values above ~2,000 ms are slow. |

### Isolation test columns (`iso:*`)

When a combination fails, the tool automatically runs a series of controlled follow-up tests to figure out *why* it failed. Each `iso:*` column shows the failure rate (%) for one of those tests.

| Column | What it tests | How to read it |
|---|---|---|
| `iso:minimal` | Sends only the category, with no tags and no names | If this fails, the taxonomy combination itself is broken — it's a prompt-level bug unrelated to tags or names |
| `iso:all-tags` | Sends all 9 possible tags at once | If minimal passes but this fails, having too many tags at once confuses the AI |
| `iso:fixed-names` | Sends all tags with generic names ("Annual Fundraiser" / "Test Organization") | If this fails but minimal passes, the random names were not the issue — it's about the tags |
| `iso:tag:Travel` | Sends only the "Travel" tag | If this fails, the Travel tag specifically causes the problem for this combination |
| `iso:tag:Fees` | Sends only the "Fees" tag | Same idea for Fees |
| `iso:tag:Supplies` | Sends only the "Supplies" tag | Same idea for Supplies |
| `iso:tag:Equipment` | Sends only the "Equipment" tag | Same idea for Equipment |
| `iso:tag:Other` | Sends only the "Other" tag | Same idea for Other |
| `iso:tag:Facilities` | Sends only the "Facilities" tag | Same idea for Facilities |
| `iso:tag:Tournament` | Sends only the "Tournament" tag | Same idea for Tournament |
| `iso:tag:Event` | Sends only the "Event" tag | Same idea for Event |
| `iso:tag:Scholarships` | Sends only the "Scholarships" tag | Same idea for Scholarships |

**Quick guide to reading isolation columns:**
- `iso:minimal` = `100%` → The combo is fundamentally broken. Tag this for the AI/prompt team.
- `iso:minimal` = `0%` but `iso:tag:X` = `100%` → A specific tag causes the failure. Tag this for the AI team with the tag name.
- `iso:minimal` = `0%` and all `iso:tag:*` = `0%` → The failure was likely caused by the random names or tags the tool used, not a real bug. May need more runs to confirm.
- Columns are **blank** for combinations that never failed (no isolation testing was needed).

---

## Status label glossary

| Label | What it means | What to do |
|---|---|---|
| `stable` | Every attempt generated a cause statement successfully | No action needed |
| `flaky` | At least one attempt failed, but not all of them | Likely a backend reliability issue. Check if the failure rate is high (>50%) or low. If it fails 1 in 10 times, a user retry would fix it; if it fails 5 in 10 times, it needs a proper fix. |
| `deterministic` | Every single attempt failed | A real bug. Check the `iso:minimal` column — if that also fails, the AI prompt doesn't handle this fundraiser type at all. |

---

## Optional: Cross-run analysis

If you run the tool multiple times (e.g. on different days, or with different settings), you can aggregate all the results for higher statistical confidence:

```sh
npx tsx analyze.ts
```

This reads all `run-*.json` files in the `results/` folder and creates a new file:
`results/analysis-{timestamp}.csv`

Use this when you want to know: *"Has this combination been consistently broken across multiple test runs, or was it a one-time thing?"*

### Understanding `analysis-*.csv` columns

| Column | What it means |
|---|---|
| `organization_type`, `activity`, `affiliation` | Same as in `run-*.csv` |
| `total_runs` | How many separate test runs included this combination |
| `total_attempts` | Total number of API calls across all runs combined |
| `failed_attempts` | How many of those calls failed |
| `flak_rate_pct` | Overall failure rate across all runs (e.g. `33.3%` = failed 1 in 3 times) |
| `confidence` | How much to trust this data: `low` = only 1–2 runs, `medium` = 3–4 runs, `high` = 5+ runs |
| `runs_stable` | How many runs where this combination always worked |
| `runs_flaky` | How many runs where this combination sometimes failed |
| `runs_deterministic` | How many runs where this combination always failed |
| `median_latency_ms` | Typical response time across all runs — half of attempts were faster than this, half were slower |
| `iso_failrate:minimal`, `iso_failrate:all-tags`, `iso_failrate:tag:X`, … | Aggregated failure rate for each isolation test across all runs — same interpretation as the `iso:*` columns in `run-*.csv` |

---

## Advanced settings

You can customize the tool's behavior by editing these values in your `.env` file before running `npm start`:

| Setting | Default | What it controls |
|---|---|---|
| `CONCURRENCY` | `5` | How many combinations to test at the same time. Higher = faster run, but more load on the server. |
| `RUNS_PER_COMBO` | `1` | How many independent passes to make over each combination (each with fresh random inputs). `1` is fine for a quick check; use `3`+ for higher confidence. |
| `FLAKINESS_RUNS` | `3` | How many times to send the **exact same request** per combination to detect flakiness. Higher = more accurate flak detection, longer run time. |
| `EVENT_NAMES_[SLUG]` | *(required)* | Comma-separated list of fundraiser event names for a specific fundraiser category. **All 9 are required** — the tool will exit immediately with an error if any are missing. Valid slugs: `ARTS`, `COMMUNITY`, `EDUCATION`, `HEALTH`, `RELIGIOUS`, `GREEK`, `SPORTS`, `OTHER`, `PERSONAL`. Example: `EVENT_NAMES_SPORTS=Season Kickoff Fund,Championship Sendoff,Game Day Campaign` |
| `ORG_NAMES_[SLUG]` | *(required)* | Comma-separated list of organization names for a specific fundraiser category. Same 9 slugs as above. Example: `ORG_NAMES_SPORTS=Falcon Athletic Boosters,Summit Soccer Club,Team United` |

Example — run faster with less thorough flakiness checking:
```sh
FLAKINESS_RUNS=1 CONCURRENCY=10 npm start
```

Example — slower but higher confidence:
```sh
FLAKINESS_RUNS=5 RUNS_PER_COMBO=3 npm start
```

---

## How it works (technical reference)

<details>
<summary>Taxonomy coverage — 176 combinations tested</summary>

| Category | Combinations |
|---|---|
| Sports & Athletics | 79 |
| Sororities & Fraternities | 13 |
| Education & Academics | 22 |
| Arts & Culture | 16 |
| Associations, Clubs & Community | 17 |
| Health & Wellness | 7 |
| Religious Organization | 5 |
| Other / Personal | 0 (no activities defined) |

Activities with affiliations produce one combination per affiliation level. Activities without affiliations produce a single combination with no affiliation.

</details>

<details>
<summary>What the tool does per combination</summary>

1. Builds a request with random tags, event name, and org name
2. Fires the **same payload** `FLAKINESS_RUNS` times to measure flakiness
3. Classifies the combination as `stable`, `flaky`, or `deterministic`
4. For any combination that had at least one failure, runs **12 isolation variants** × `FLAKINESS_RUNS` to identify root cause

A response is classified as failed if `generated === false` OR the `text` field is empty or whitespace.

</details>

<details>
<summary>Output files written to results/</summary>

| File | Contents |
|---|---|
| `run-{timestamp}.csv` | **Main results file** — one row per combination with all stats and isolation columns |
| `run-{timestamp}.json` | Full raw results — includes complete request/response payloads |
| `failures-{timestamp}.json` | Failed combinations only — complete payloads ready for Postman or curl |
| `analysis-{timestamp}.csv` | Cross-run aggregation (only created by `npx tsx analyze.ts`) |

</details>

<details>
<summary>Latency anomalies</summary>

The cross-run analysis also flags combinations with a median response time more than 2× higher than the global median. These slow combinations can cause timeouts that show up as empty responses — so a combination marked `flaky` with high latency may actually be a timeout issue rather than a prompt bug.

</details>
