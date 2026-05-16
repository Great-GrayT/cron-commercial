# Changes 2

## Fix 0: Month selector — view any archive month, not just current

**Files:** `src/app/page.tsx`

### Problem
The VIEW toggle only offered ALL (all-time aggregated) and CURRENT (current month). There was no way to inspect a past month in isolation.

### Fix
Replaced the `useAggregated: boolean` state with a `viewMode: string` that holds `'all'`, `'current'`, or a `'YYYY-MM'` archive month. The VIEW section in the KEY METRICS panel is now a `<select>` dropdown populated from `statsData.summary.availableArchives`. Selecting an archive month:
- Updates `getActiveStatistics()` to return that month's pre-loaded statistics
- Updates `availableFilterOptions` to reflect that month's filter values
- Clears `selectedDate` to avoid stale date-highlight state

**Limitation:** Individual job records are not available for archive months, so the RECENT JOBS table will be empty and filter-level reconstruction does not narrow charts further. Filter chips are visible but act as read-only labels for archive views.

---

## Fix 1: PUBLICATION TIMES and POSTING HEATMAP connected to correct data

**Files:** `src/app/page.tsx`

### Problem
In ALL mode with filters applied, `filteredStatistics` explicitly preserved `byHour` and `byDayHour` as the all-time unfiltered aggregated values. `getPublicationTimeData()` also read `getActiveStatistics()?.byHour` directly, bypassing `filteredStatistics` entirely. The result: selecting any filter had zero effect on these two charts.

### Fix
1. **`filteredStatistics` (ALL mode path):** Removed the explicit preservation of `byHour`/`byDayHour`. They are now rebuilt from `filteredJobs` using the same UTC hour/day-hour extraction already used in CURRENT mode.
2. **`getPublicationTimeData()`:** Changed to read `filteredStats?.byHour` (i.e., `filteredStatistics`) instead of calling `getActiveStatistics()`, so the chart always reflects whatever filters are active.
3. **POSTING HEATMAP** already consumed `filteredStats?.byDayHour`; fixing point 1 above is sufficient.

---

## Fix 2 & 3: Filters work correctly and RECENT JOBS table is populated

**Files:** `src/app/api/stats/load/route.ts`, `src/app/page.tsx`

### Problem
The API `/api/stats/load` never included individual job records in its response. `statsData.currentMonth.jobs` was always `undefined`, so `filteredJobs` always returned `[]`. Consequences:
- Any active filter caused `filteredStatistics` to rebuild from zero jobs → all charts emptied.
- RECENT JOBS (TOP 100) always showed an empty table.

### Fix — API (`src/app/api/stats/load/route.ts`)
Added a call to `statsCache.loadJobsForMonth(currentMonthSummary.month)` after the existing aggregation load. The jobs array is included in the `currentMonth` field of the response. A `typeof` guard ensures the call is skipped gracefully if the Gist storage backend is used (which lacks this method).

Also removed the stripping of `statistics` from the per-archive entries in the `aggregated.archives` array, so each archive entry now includes its full `MonthlyStatistics` — required for the month selector (Fix 0).

### Fix — Frontend (`src/app/page.tsx`)
- `StatsData.currentMonth` now declares `jobs?: JobStatistic[]`.
- `StatsData.aggregated.archives` entries now declare `statistics: MonthlyStatistics`.
- `filteredJobs` removed the `as any` cast; reads `statsData.currentMonth.jobs` directly.
- Added a `selectedArchiveMonth` guard at the top of `filteredJobs`: returns `[]` immediately for archive months (no records available).

---

## Fix 4: Decouple jobs from stats load to fix Vercel 500 (response size + timeout)

**Files:** `src/app/api/stats/load/route.ts`, `src/app/api/stats/jobs/route.ts` *(new)*, `vercel.json`, `src/app/page.tsx`, `src/app/page.css`

### Root cause

Two issues introduced by Fix 2 & 3 caused HTTP 500 on Vercel:

1. **Response size** — adding `jobs: currentMonthJobs` to `/api/stats/load` pushed the response to 1.5–4 MB for jobs alone (2 000–5 000 records × metadata + partial descriptions), plus ~1.2 MB for 12 months of archive statistics. The total exceeded Vercel's **4.5 MB serverless response hard limit**, which returns a 500 at the CDN edge — not a 413 — so it never manifested locally.

2. **`maxDuration` not honoured** — the route exported `maxDuration = 300` but `vercel.json` had no matching entry. On Hobby plan Vercel ignores the in-file setting and caps at 10 s. The new sequential `getAllArchivesAggregated() → loadJobsForMonth()` chain can take 8–15 s and hit that cap.

### Fix — API

**`src/app/api/stats/load/route.ts`** — removed the `loadJobsForMonth` call and `jobs` field from the response. The route now only fetches aggregated stats → response stays well under 200 KB.

**`src/app/api/stats/jobs/route.ts`** *(new)* — dedicated endpoint `GET /api/stats/jobs?month=YYYY-MM` that streams job records for a given month. Has its own `export const maxDuration = 300`.

**`vercel.json`** — added entries for both routes so `maxDuration: 300` is enforced at the infra level on all Vercel plans:
```json
"app/api/stats/load/route.ts": { "maxDuration": 300 },
"app/api/stats/jobs/route.ts": { "maxDuration": 300 }
```

### Fix — Frontend (`src/app/page.tsx`, `src/app/page.css`)

- Added `jobsLoading: boolean` state.
- Added a `useEffect` that fires after `statsData` arrives and lazily `fetch`es `/api/stats/jobs?month=<currentMonth>`, then merges the result into `statsData.currentMonth.jobs`. Non-fatal: on fetch failure jobs default to `[]` and charts remain functional.
- RECENT JOBS panel header shows a spinner while `jobsLoading` is true.
- Table body shows a "Loading jobs…" placeholder row while loading and `filteredJobs` is still empty.
- Added `.jobs-loading-row td` and `.panel-header-spinner` CSS classes to [page.css](src/app/page.css) (no inline styles).

---

## Fix 5: PUBLICATION TIMES, POSTING HEATMAP, and RECENT JOBS broken after Fix 4

**Files:** `src/app/page.tsx`

### Problems

**PUBLICATION TIMES empty on CURRENT mode:** `getPublicationTimeData()` entered the `if (useAggregated || selectedArchiveMonth)` branch only for ALL and archive views. In CURRENT mode the branch was skipped entirely, falling through to `filteredJobs` (which is now lazy-loaded and starts empty). The chart was blank until jobs arrived.

**PUBLICATION TIMES empty on archive months:** The function did enter the stats branch for archives, but old archive `stats/YYYY-MM.json` files may not have a `byHour` field (added later). When `byHour` was missing the function fell through to `filteredJobs`, which is always `[]` for archive months → permanently empty.

**RECENT JOBS empty:** The lazy-load `useEffect` used `[statsData?.currentMonth.month]` as its dependency. This expression evaluates to the same string on every subsequent render (the month never changes). If a stale closure captured `statsData` before jobs were set, the guard `statsData.currentMonth.jobs !== undefined` could incorrectly early-return, preventing the fetch.

### Fix

**`getPublicationTimeData`** — removed the mode guard entirely. The function now always tries `filteredStats?.byHour` first (available in every view without waiting for the lazy job load). Only falls through to individual job records as a true last resort (old archives without `byHour`, or when filter-rebuilt `filteredStatistics` already has correct `byHour` computed from filtered jobs).

**Jobs `useEffect` dependency** — changed from `[statsData?.currentMonth.month]` to `[statsData]`. This ensures the effect re-evaluates with the freshest closure every time `statsData` changes reference, while the `statsData.currentMonth.jobs !== undefined` guard still prevents duplicate fetches once jobs are loaded.

---

## Fix 6: PUBLICATION TIMES bars are flat/identical within each hour

**Files:** `src/app/page.tsx`

### Problem
The `byHour` path in `getPublicationTimeData` distributed each hour's count across 6 synthetic 10-minute slots using `Math.round(count / 6)`. This produced 6 equal-height bars per hour — a flat, misleading chart — because no actual per-minute data exists in `byHour`.

### Fix
Flipped the priority order in `getPublicationTimeData`:
1. **Jobs available first** — when `filteredJobs` is non-empty (i.e., current-month jobs have lazy-loaded), compute real 10-minute slot counts from `job.postedDate`. This gives genuine sub-hour variation.
2. **Hourly fallback** — when jobs aren't available (ALL mode aggregated, archive months), emit one honest bar per hour at `HH:00` with the true hourly count. No synthetic splitting.

The previous order (stats-first) meant the synthetic hourly spread always won, even when real job data was present.
