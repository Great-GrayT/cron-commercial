# Change 3: Description Lazy-Loading & Payload Reduction

## Goal

Eliminate the largest source of unnecessary payload — job descriptions (~1.5 MB/day compressed,
up to 7.5 MB total) — while keeping all filters, charts, and interactions fully functional.
Metadata (lightweight job records without descriptions) is still loaded for the full current month
on page load. Descriptions are fetched on-demand only when the user actually needs them.

---

## Project Context

### Tech Stack
- Next.js 14 App Router, TypeScript, React client components
- Cloudflare R2 (S3-compatible) for storage, accessed via `@aws-sdk/client-s3`
- Main lib files: `src/lib/r2-storage.ts`, `src/lib/job-statistics-r2.ts`, `src/lib/stats-storage.ts`

### R2 File Structure
```
manifest.json                          → index of all months and days (lightweight)
url-index.json                         → all known job URLs for deduplication (server-side only)
stats/YYYY-MM.json                     → pre-computed statistics per month (~50KB)
aggregated-stats.json                  → all months merged into one stats object (~100KB)
metadata/YYYY/MM/day-DD.ndjson.gz     → lightweight job records without descriptions (~150KB/day compressed)
descriptions/YYYY/MM/day-DD.ndjson.gz → job descriptions only (~1.5MB/day compressed)
```

### Current API Endpoints (relevant ones)
- `GET /api/stats/load` → reads manifest + url-index + stats/YYYY-MM.json + aggregated-stats.json → returns pre-computed stats for all view modes
- `GET /api/stats/jobs?month=YYYY-MM[&days=N][&date=YYYY-MM-DD][&all=true]` → loads metadata only (no descriptions). Default: all days.
- `GET /api/stats/description?date=YYYY-MM-DD` → (new) loads descriptions for a single date on demand.

### Key Source Files
- `src/lib/job-statistics-r2.ts` — `JobStatisticsCacheR2` class. Relevant methods: `load()`, `loadJobsForMonth()`, `loadDescriptionsForDate()` (new)
- `src/app/api/stats/jobs/route.ts` — calls `statsCache.loadJobsForMonth(month, options)`
- `src/app/api/stats/description/route.ts` — (new) calls `statsCache.loadDescriptionsForDate(date)`
- `src/app/page.tsx` — dashboard UI (~2200 lines, "use client")
- `src/components/SearchFilterPanel.tsx` — search bar + filter dropdowns

---

## Problem That Was Solved

**Before this change**, `GET /api/stats/jobs` fetched ALL days of metadata (up to 31 R2 reads)
**plus** descriptions for the 5 most recent days on every page load, regardless of whether the
user ever opened a job description popup. This was up to ~7.5 MB of description data transferred
on every visit.

**What was NOT changed**: Filters, charts, heatmap, and publication times all continue to work
exactly as before — they rebuild from `filteredJobs` (metadata) when filters are active.

---

## Actual Behavior After This Change

### Metadata (Job Records)
- On page load: fetch **all** metadata for the current month (no change in coverage vs before).
- Descriptions are stripped — all returned jobs have `description: ''`.
- `filteredJobs` is built from a client-side `Map<id, JobStatistic>` (`loadedJobsById`) instead
  of `statsData.currentMonth.jobs`.

### Descriptions
- **Never pre-loaded.**
- **Job description popup**: when the hover timer fires (3 s), `loadDescriptionsForDate(dateKey)`
  is called. This fetches `GET /api/stats/description?date=YYYY-MM-DD` and stores the result in a
  client-side `Map<id, string>` (`descriptionCache`). The popup shows a spinner while loading.
- **Text search on descriptions**: text search on title/company/keywords works at all times.
  When a date is selected on the Velocity chart AND text search is non-empty, descriptions for
  that date are auto-fetched so the search can match description content too. A hint is shown in
  the search bar explaining this.

### Charts & Filters
- All charts rebuild from `filteredJobs` (metadata) when filters are active — same behavior as
  before this change.
- When no filters are active, pre-computed stats from `aggregated-stats.json` / `stats/YYYY-MM.json`
  are used directly (fast path).
- `PostingHeatmap` and `Publication Times` use `filteredJobs` for real resolution when jobs are
  loaded, falling back to pre-computed `byDayHour`/`byHour` otherwise.

### On-Demand Date Metadata
- Clicking a date dot on the **Posting Velocity** chart calls `loadDateMetadata(date)` which
  fetches `GET /api/stats/jobs?month=X&date=YYYY-MM-DD` for that specific date (if not already
  loaded). This adds those jobs to `loadedJobsById` without replacing existing ones.

---

## Precise Changes Per File

---

### FILE 1: `src/lib/job-statistics-r2.ts`

#### Change 1a — Modify `loadJobsForMonth()` to accept options

New signature:
```ts
async loadJobsForMonth(
  month: string,
  options: { days?: number; date?: string } = {}
): Promise<JobStatistic[]>
```

- `options.date` → load only that specific date
- `options.days` → load only the last N days
- no options → load all days (default)
- **Descriptions are NEVER loaded.** All returned jobs have `description: ''`.

#### Change 1b — Add `loadDescriptionsForDate()`

```ts
async loadDescriptionsForDate(dateKey: string): Promise<Map<string, string>>
```

Returns a `Map<jobId, description>` for the given `YYYY-MM-DD`. Returns an empty Map on 404.

#### Change 1c — Strip description loading from `loadJobsForDateRange()`

Removed the `shouldLoadDescriptions` / `descMap` / description-loading block. All returned jobs
have `description: ''`.

---

### FILE 2: `src/app/api/stats/jobs/route.ts`

Supports query parameters:
- `month` (required)
- `days` (optional) — load last N days
- `date` (optional) — load a specific date
- `all=true` (optional) — load all days (this is the page-load default)

Default when no limit param is given: load all days (`options = {}`).

---

### FILE 3: `src/app/api/stats/description/route.ts` (NEW FILE)

`GET /api/stats/description?date=YYYY-MM-DD`

Returns `{ success: true, date, descriptions: Array<{ id, description }> }`.

---

### FILE 4: `src/app/page.tsx`

#### New state
```ts
const [loadedDates, setLoadedDates] = useState<Set<string>>(new Set());
const [loadedJobsById, setLoadedJobsById] = useState<Map<string, JobStatistic>>(new Map());
const [descriptionCache, setDescriptionCache] = useState<Map<string, string>>(new Map());
const [loadingDescriptionsDate, setLoadingDescriptionsDate] = useState<string | null>(null);
```

#### Background metadata load (replaces old jobs useEffect)
Fetches `?month=X&all=true` (all metadata, no descriptions) after stats load. Populates
`loadedJobsById` and `loadedDates`.

#### New helpers
- `loadDateMetadata(date)` — fetches a single date's metadata if not already loaded
- `loadDescriptionsForDate(date)` — fetches descriptions for a date and merges into `descriptionCache`

#### `filteredJobs` useMemo
Data source changed from `statsData.currentMonth.jobs` to `Array.from(loadedJobsById.values())`,
with descriptions merged from `descriptionCache`. All filter logic is identical.

#### `filteredStatistics` useMemo
Unchanged in behavior: rebuilds from `filteredJobs` when `hasJobFilters` is true; returns
pre-computed stats when no filters are active.

#### `handleDateClick`
Also calls `loadDateMetadata(newDate)` and — if text search is active — `loadDescriptionsForDate(newDate)`.

#### Job description popup
Checks `descriptionCache.get(hoveredJob.id)` first; shows a spinner while `loadingDescriptionsDate === dateKey`.

#### `StatsData` interface
`jobs?` field removed from `currentMonth` (jobs now live in `loadedJobsById`).

---

### FILE 5: `src/components/SearchFilterPanel.tsx`

Added props:
```ts
selectedDate: string | null;
loadingDescriptions?: boolean;
```

Shows a hint below the search input:
- No date selected + text search active → "Select a date on the velocity chart to also search descriptions"
- Date selected + loading → spinner + "Loading descriptions for {date}…"
- Date selected + loaded → "Searching metadata + descriptions for {date}"

---

### FILE 6: `src/app/page.tsx` — Loading UX (terminal-themed progress screen)

#### New state
```ts
const [loadingStep, setLoadingStep] = useState('INITIALIZING...');
const [loadingProgress, setLoadingProgress] = useState(0);
```

#### New refs (imperative width update to avoid inline-style linter warnings)
```ts
const loadingBarRef = useRef<HTMLDivElement>(null);
const jobsBarRef = useRef<HTMLDivElement>(null);
```

A `useEffect` syncs both refs to `loadingProgress` on every change:
```ts
useEffect(() => {
  if (loadingBarRef.current) loadingBarRef.current.style.width = `${loadingProgress}%`;
  if (jobsBarRef.current) jobsBarRef.current.style.width = `${loadingProgress}%`;
}, [loadingProgress]);
```

#### Stage progression

**Phase 1 — stats fetch** (inside `loadStatistics`):
| Progress | Step text |
|---|---|
| 8 % | `CONNECTING TO DATA LAYER...` |
| 20 % | `LOADING MARKET STATISTICS...` |
| 60 % | `PROCESSING STATISTICS...` |
| 80 % | `BUILDING CHART DATA...` |

On retry: `CONNECTION ERROR — RETRYING (n/N)...` at 5 %.

**Phase 2 — metadata fetch** (in the `statsData` useEffect):
| Progress | Step text |
|---|---|
| 85 % | `LOADING JOB RECORDS...` |
| 100 % | `READY` |

#### Full loading screen (shown while `loading === true`)

Terminal-card overlay with:
- Brand header: `BarChart3` icon + `JOB MARKET ANALYTICS` / `RECRUITMENT INTELLIGENCE TERMINAL`
- Blinking cursor prompt: `> {loadingStep} █`
- Animated progress bar (`.loading-bar-fill`, width driven imperatively via ref)
- Footer row: percentage on the left, `STAGE N / 3` label on the right

#### Slim jobs-loading strip (shown when `!loading && jobsLoading`)

Single-row banner below the top bar with: stage text, 4 px progress bar (ref-driven), percentage.

#### New CSS classes (in `src/app/page.css`)

Loading screen: `.loading-screen`, `.loading-screen-card`, `.loading-brand`, `.loading-brand-icon`,
`.loading-brand-title`, `.loading-brand-sub`, `.loading-stage`, `.loading-prompt`,
`.loading-stage-text`, `.loading-cursor` (blinking), `.loading-bar-track`, `.loading-bar-fill`,
`.loading-bar-footer`, `.loading-pct`, `.loading-steps-hint`

Jobs strip: `.jobs-loading-strip`, `.jobs-loading-label`, `.jobs-loading-bar-track`,
`.jobs-loading-bar-fill`, `.jobs-loading-pct`

---

## API Endpoints After This Change

| Endpoint | When called | R2 reads | Response size |
|---|---|---|---|
| `GET /api/stats/load` | On page mount + LOAD DATA button | manifest + url-index + stats/current + aggregated-stats | ~150KB |
| `GET /api/stats/jobs?month=X&all=true` | Background after page load | all metadata files for month | ~450KB–4.5MB |
| `GET /api/stats/jobs?month=X&date=YYYY-MM-DD` | On velocity chart date click (if not already loaded) | 1 metadata file | ~150KB |
| `GET /api/stats/description?date=YYYY-MM-DD` | On job hover (3 s delay) or text search + date | 1 descriptions file | ~1.5MB |

vs. **before**: every page load triggered metadata + up to 7.5MB of descriptions whether the user
needed them or not.

---

## Files Modified / Created

### Created
- `src/app/api/stats/description/route.ts`

### Modified
- `src/lib/job-statistics-r2.ts`
- `src/app/api/stats/jobs/route.ts`
- `src/app/page.tsx`
- `src/components/SearchFilterPanel.tsx`
- `src/components/SearchFilterPanel.css`
- `src/app/page.css`
