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
