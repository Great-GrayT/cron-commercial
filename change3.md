# Change 3: Interaction-Driven Loading & Payload Reduction

## Goal

Reduce client payload size by making heavy R2 data loads depend on explicit user interaction rather than happening automatically on every page load. Charts always use pre-computed aggregated data. Individual job records (metadata) are loaded incrementally. Descriptions are never pre-loaded — they are fetched on-demand only when the user explicitly needs them.

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
- `GET /api/stats/jobs?month=YYYY-MM` → calls `loadJobsForMonth()` which fetches ALL metadata files for the month in parallel + last 5 days of descriptions. This is the heavy endpoint.

### Key Source Files
- `src/lib/job-statistics-r2.ts` — `JobStatisticsCacheR2` class. Relevant methods: `load()`, `loadJobsForMonth()`, `loadMetadataForDate()` (already exists as private-ish pattern), `loadJobDescription()`
- `src/app/api/stats/jobs/route.ts` — calls `statsCache.loadJobsForMonth(month)`
- `src/app/page.tsx` — the entire dashboard UI (~2200 lines, "use client")
- `src/components/SearchFilterPanel.tsx` — search bar + filter dropdowns
- `src/components/charts/PostingHeatmap.tsx` — accepts both `jobs: Job[]` and `byDayHour?: Record<string, number>`, prefers `byDayHour` if present

---

## Current Problem Summary

1. `GET /api/stats/jobs` fetches ALL days of metadata (up to 31 R2 reads) + 5 days of descriptions on every page load regardless of user interaction.
2. Charts rebuild their data from individual `filteredJobs` when filters are active, forcing the full job load.
3. `PostingHeatmap` and `Publication Times` chart prefer individual job records even though pre-computed `byDayHour`/`byHour` fields exist in the stats.
4. Descriptions (~1.5MB/day, 5 days = up to 7.5MB) are downloaded for every user even if they never open a job description popup.
5. Text search scans `job.description` which requires descriptions to be pre-loaded.

---

## Target Behavior After This Change

### Charts
All charts always read from pre-computed stats (`aggregated-stats.json` or `stats/YYYY-MM.json`). They never depend on individual job records. Filters applied via the filter panel do NOT alter chart data — charts always show the macro picture for the selected view mode (ALL / CURRENT / specific month). Only the jobs table and job count in Key Metrics reflect active filters.

### Jobs Table
- On page load: fetch only the last **3 days** of metadata for the current month.
- When user clicks a date dot on the **Posting Velocity** chart: fetch metadata for that specific date on-demand (if not already loaded).
- A **"LOAD FULL MONTH"** button in the jobs table panel fetches all remaining days.
- Fetched days are merged into a client-side job list; already-loaded days are not re-fetched.

### Descriptions
- **Never pre-loaded.**
- **Job description popup**: on hover, if the description is not yet in a local cache, call `GET /api/stats/description?date=YYYY-MM-DD` which returns all descriptions for that day. Cache them client-side. Show a loading spinner in the popup while fetching.
- **Text search on descriptions**: text search on title/company/keywords works at all times (these fields are in metadata). To also search descriptions, the user must have a date selected (from the velocity chart click). When a date is selected AND text search is non-empty, the system automatically fetches that date's descriptions. A hint message is shown in the search bar when text search is active but no date is selected: `"Select a date on the chart to also search descriptions"`.

### Publication Times & Heatmap
Both charts use pre-computed `byHour` / `byDayHour` fields from `filteredStatistics` (which is now always the pre-computed stats). They no longer depend on `filteredJobs`. The `jobs` prop passed to `PostingHeatmap` becomes an empty array; it will use `byDayHour` exclusively.

---

## Precise Changes Per File

---

### FILE 1: `src/lib/job-statistics-r2.ts`

#### Change 1a — Modify `loadJobsForMonth()` to accept options

**Current signature (line ~738):**
```ts
async loadJobsForMonth(month: string): Promise<JobStatistic[]>
```

**Replace entire `loadJobsForMonth` method with:**
```ts
/**
 * Load job metadata for a month.
 * Options:
 *   - days: load only the last N days (default: all days)
 *   - date: load only a specific date (YYYY-MM-DD), overrides days
 * Descriptions are NEVER loaded here. All returned jobs have description: ''.
 */
async loadJobsForMonth(
  month: string,
  options: { days?: number; date?: string } = {}
): Promise<JobStatistic[]> {
  if (!this.manifest?.months[month]) {
    return [];
  }

  const monthData = this.manifest.months[month];
  let daysToLoad = [...monthData.days];

  if (options.date) {
    // Load only the specific date
    daysToLoad = daysToLoad.filter(d => d.date === options.date);
  } else if (options.days !== undefined) {
    // Load only the last N days (most recent first, then take N)
    const sorted = [...daysToLoad].sort((a, b) => b.date.localeCompare(a.date));
    daysToLoad = sorted.slice(0, options.days);
  }

  const jobs: JobStatistic[] = [];

  const dayPromises = daysToLoad.map(async (day) => {
    try {
      const metadata = await this.r2.getNDJSONGzipped<JobMetadata>(day.metadata);
      return metadata.map(m => ({ ...m, description: '' } as JobStatistic));
    } catch (error) {
      logger.warn(`⚠ Failed to load metadata for ${day.date}, skipping:`, error);
      return [];
    }
  });

  const dayResults = await Promise.all(dayPromises);
  for (const dayJobs of dayResults) {
    jobs.push(...dayJobs);
  }

  // Include pending jobs for this month (only if loading all days)
  if (!options.date && options.days === undefined) {
    for (const [dateKey, pendingJobs] of this.pendingJobs.entries()) {
      if (dateKey.startsWith(month)) {
        jobs.push(...pendingJobs);
      }
    }
  }

  return jobs;
}
```

#### Change 1b — Add new method `loadDescriptionsForDate()`

Add this method after `loadJobsForMonth`:

```ts
/**
 * Load all descriptions for a specific date (YYYY-MM-DD).
 * Returns a map of jobId → description string.
 */
async loadDescriptionsForDate(dateKey: string): Promise<Map<string, string>> {
  const [year, month, day] = dateKey.split('-');
  const descriptionsKey = `descriptions/${year}/${month}/day-${day}.ndjson.gz`;

  try {
    const descriptions = await this.r2.getNDJSONGzipped<JobDescription>(descriptionsKey);
    const map = new Map<string, string>();
    for (const d of descriptions) {
      map.set(d.id, d.description);
    }
    return map;
  } catch (error: any) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      return new Map();
    }
    throw error;
  }
}
```

#### Change 1c — Remove description loading from `loadJobsForDateRange()`

The `loadJobsForDateRange` method currently also loads descriptions for recent dates. Strip that out so it only loads metadata:

Find the method and remove the entire `shouldLoadDescriptions` / `descMap` / description-loading block. All returned jobs should have `description: ''`. The method signature and day-iteration logic stays the same, just remove description loading.

---

### FILE 2: `src/app/api/stats/jobs/route.ts`

**Replace the entire file with:**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getStatsCache } from "@/lib/stats-storage";
import { validateEnvironmentVariables } from "@/lib/validation";
import { logger } from "@/lib/logger";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * GET /api/stats/jobs?month=YYYY-MM[&days=N][&date=YYYY-MM-DD]
 *
 * Returns job metadata (no descriptions) for the requested month.
 *
 * Query parameters:
 *   month (required) - YYYY-MM
 *   days  (optional) - load only the last N days. Default: 3.
 *   date  (optional) - load only this specific date (YYYY-MM-DD). Overrides days.
 *   all   (optional) - if "true", load all days (ignores days param). For "Load Full Month" button.
 */
export async function GET(request: NextRequest) {
  try {
    validateEnvironmentVariables();

    const { searchParams } = request.nextUrl;
    const month = searchParams.get("month");
    if (!month) {
      return NextResponse.json(
        { error: "Missing required query parameter: month (YYYY-MM)" },
        { status: 400 }
      );
    }

    const dateParam = searchParams.get("date") ?? undefined;
    const allParam = searchParams.get("all") === "true";
    const daysParam = searchParams.get("days");

    let options: { days?: number; date?: string } = { days: 3 }; // default: last 3 days

    if (dateParam) {
      options = { date: dateParam };
    } else if (allParam) {
      options = {}; // load all days
    } else if (daysParam) {
      const parsed = parseInt(daysParam, 10);
      if (!isNaN(parsed) && parsed > 0) {
        options = { days: parsed };
      }
    }

    const statsCache = await getStatsCache();
    await statsCache.load();

    if (typeof statsCache.loadJobsForMonth !== "function") {
      return NextResponse.json({ success: true, month, jobs: [] });
    }

    logger.info(`Loading jobs for month: ${month}, options: ${JSON.stringify(options)}`);
    const jobs = await statsCache.loadJobsForMonth(month, options);

    return NextResponse.json({ success: true, month, jobs });
  } catch (error) {
    logger.error("Error fetching jobs:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch jobs",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
```

---

### FILE 3: `src/app/api/stats/description/route.ts` (NEW FILE)

Create this file at the path above:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getStatsCache } from "@/lib/stats-storage";
import { validateEnvironmentVariables } from "@/lib/validation";
import { logger } from "@/lib/logger";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * GET /api/stats/description?date=YYYY-MM-DD
 *
 * Returns all job descriptions for the given date.
 * Response: { success: true, date, descriptions: Array<{ id: string, description: string }> }
 *
 * Used for:
 * - On-demand job description popup (hover on a job row)
 * - Text search that includes description content (requires date selection)
 */
export async function GET(request: NextRequest) {
  try {
    validateEnvironmentVariables();

    const date = request.nextUrl.searchParams.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json(
        { error: "Missing or invalid required query parameter: date (YYYY-MM-DD)" },
        { status: 400 }
      );
    }

    const statsCache = await getStatsCache();
    await statsCache.load();

    if (typeof statsCache.loadDescriptionsForDate !== "function") {
      return NextResponse.json({ success: true, date, descriptions: [] });
    }

    logger.info(`Loading descriptions for date: ${date}`);
    const descMap = await statsCache.loadDescriptionsForDate(date);

    const descriptions = Array.from(descMap.entries()).map(([id, description]) => ({
      id,
      description,
    }));

    return NextResponse.json({ success: true, date, descriptions });
  } catch (error) {
    logger.error("Error fetching descriptions:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch descriptions",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
```

---

### FILE 4: `src/app/page.tsx`

This file is ~2200 lines. Apply the following changes in order.

---

#### Change 4a — Add new state variables (after line ~185, after the existing `useRef` declarations)

Add:
```ts
// Tracks which dates have had their metadata loaded (Set of "YYYY-MM-DD" strings)
const [loadedDates, setLoadedDates] = useState<Set<string>>(new Set());
// All loaded job records across all fetched dates, keyed by job id for dedup
const [loadedJobsById, setLoadedJobsById] = useState<Map<string, JobStatistic>>(new Map());
// Client-side description cache: jobId → description string
const [descriptionCache, setDescriptionCache] = useState<Map<string, string>>(new Map());
// Whether we're currently fetching descriptions for a date
const [loadingDescriptionsDate, setLoadingDescriptionsDate] = useState<string | null>(null);
// Whether all-month metadata has been loaded (for "Load Full Month" button)
const [fullMonthLoaded, setFullMonthLoaded] = useState(false);
const [fullMonthLoading, setFullMonthLoading] = useState(false);
```

---

#### Change 4b — Replace the background jobs fetch `useEffect` (currently around lines 191–213)

**Remove this entire block:**
```ts
// After stats load, fetch jobs for the current month in the background
useEffect(() => {
  if (!statsData || statsData.currentMonth.jobs !== undefined) return;
  const month = statsData.currentMonth.month;
  setJobsLoading(true);
  fetch(`/api/stats/jobs?month=${encodeURIComponent(month)}`)
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(data => {
      setStatsData(prev => { ... });
    })
    ...
  }, [statsData]);
```

**Replace with:**
```ts
// After stats load, fetch only the last 3 days of metadata for the current month
useEffect(() => {
  if (!statsData) return;
  const month = statsData.currentMonth.month;
  setJobsLoading(true);
  fetch(`/api/stats/jobs?month=${encodeURIComponent(month)}&days=3`)
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(data => {
      const jobs: JobStatistic[] = data.jobs ?? [];
      const newById = new Map<string, JobStatistic>();
      const newDates = new Set<string>();
      jobs.forEach(job => {
        newById.set(job.id, job);
        const d = job.extractedDate?.split('T')[0];
        if (d) newDates.add(d);
      });
      setLoadedJobsById(newById);
      setLoadedDates(newDates);
    })
    .catch(() => {
      // Non-fatal: table will be empty but charts still work
    })
    .finally(() => setJobsLoading(false));
}, [statsData?.currentMonth?.month]); // Only re-run if month changes
```

---

#### Change 4c — Add a helper to load a specific date's metadata on-demand

Add this function inside the component (after `loadStatistics`):

```ts
const loadDateMetadata = async (date: string) => {
  if (loadedDates.has(date) || !statsData) return;
  const month = date.substring(0, 7); // YYYY-MM
  try {
    const r = await fetch(`/api/stats/jobs?month=${encodeURIComponent(month)}&date=${encodeURIComponent(date)}`);
    if (!r.ok) return;
    const data = await r.json();
    const jobs: JobStatistic[] = data.jobs ?? [];
    setLoadedJobsById(prev => {
      const next = new Map(prev);
      jobs.forEach(job => next.set(job.id, job));
      return next;
    });
    setLoadedDates(prev => new Set([...prev, date]));
  } catch {
    // Non-fatal
  }
};
```

---

#### Change 4d — Add a helper to load the full month's metadata on-demand

```ts
const loadFullMonth = async () => {
  if (fullMonthLoaded || fullMonthLoading || !statsData) return;
  setFullMonthLoading(true);
  const month = statsData.currentMonth.month;
  try {
    const r = await fetch(`/api/stats/jobs?month=${encodeURIComponent(month)}&all=true`);
    if (!r.ok) return;
    const data = await r.json();
    const jobs: JobStatistic[] = data.jobs ?? [];
    const newById = new Map<string, JobStatistic>(loadedJobsById);
    const newDates = new Set<string>(loadedDates);
    jobs.forEach(job => {
      newById.set(job.id, job);
      const d = job.extractedDate?.split('T')[0];
      if (d) newDates.add(d);
    });
    setLoadedJobsById(newById);
    setLoadedDates(newDates);
    setFullMonthLoaded(true);
  } catch {
    // Non-fatal
  } finally {
    setFullMonthLoading(false);
  }
};
```

---

#### Change 4e — Add a helper to load descriptions for a date on-demand

```ts
const loadDescriptionsForDate = async (date: string) => {
  if (loadingDescriptionsDate === date || !date) return;
  setLoadingDescriptionsDate(date);
  try {
    const r = await fetch(`/api/stats/description?date=${encodeURIComponent(date)}`);
    if (!r.ok) return;
    const data = await r.json();
    const descs: Array<{ id: string; description: string }> = data.descriptions ?? [];
    setDescriptionCache(prev => {
      const next = new Map(prev);
      descs.forEach(d => next.set(d.id, d.description));
      return next;
    });
  } catch {
    // Non-fatal
  } finally {
    setLoadingDescriptionsDate(null);
  }
};
```

---

#### Change 4f — Modify `handleDateClick` to also trigger metadata load

Find the existing `handleDateClick` function:
```ts
const handleDateClick = (data: any) => {
  if (!data || !data.activePayload || !data.activePayload[0]) return;
  const clickedDate = data.activePayload[0].payload.rawDate;
  if (!clickedDate) return;
  setSelectedDate(selectedDate === clickedDate ? null : clickedDate);
};
```

Replace with:
```ts
const handleDateClick = (data: any) => {
  if (!data || !data.activePayload || !data.activePayload[0]) return;
  const clickedDate = data.activePayload[0].payload.rawDate;
  if (!clickedDate) return;
  const newDate = selectedDate === clickedDate ? null : clickedDate;
  setSelectedDate(newDate);
  if (newDate) {
    // Load metadata for this date if not already loaded
    loadDateMetadata(newDate);
    // If text search is active, also load descriptions for this date
    if (debouncedTextSearch) {
      loadDescriptionsForDate(newDate);
    }
  }
};
```

---

#### Change 4g — Add a `useEffect` to load descriptions when text search + selected date are both set

Add after the debounce `useEffect`:
```ts
// When text search becomes active and a date is already selected, load descriptions for that date
useEffect(() => {
  if (debouncedTextSearch && selectedDate && selectedDateAffectsJobs) {
    loadDescriptionsForDate(selectedDate);
  }
}, [debouncedTextSearch, selectedDate]);
```

---

#### Change 4h — Replace `filteredJobs` useMemo to use `loadedJobsById` instead of `statsData.currentMonth.jobs`

Find the `filteredJobs` useMemo (currently around line 445). The top of it reads:
```ts
const filteredJobs = useMemo(() => {
  if (!statsData) return [];
  if (selectedArchiveMonth) return [];
  const jobs = statsData.currentMonth.jobs;
  if (!jobs?.length) return [];
  return jobs.filter(job => { ... });
```

Change the data source from `statsData.currentMonth.jobs` to the new `loadedJobsById` map, and merge in description cache:

```ts
const filteredJobs = useMemo(() => {
  if (!statsData) return [];
  if (selectedArchiveMonth) return [];

  // Build array from loaded metadata, merging in any cached descriptions
  const jobs = Array.from(loadedJobsById.values()).map(job => ({
    ...job,
    description: descriptionCache.get(job.id) || '',
  }));

  if (!jobs.length) return [];

  return jobs.filter(job => {
    // Text search: searches title, company, keywords always.
    // Searches description only if it has been loaded (non-empty).
    if (debouncedTextSearch) {
      const searchLower = debouncedTextSearch.toLowerCase();
      const matchesSearch =
        job.title.toLowerCase().includes(searchLower) ||
        job.company.toLowerCase().includes(searchLower) ||
        (job.description && job.description.toLowerCase().includes(searchLower)) ||
        job.keywords.some(k => k.toLowerCase().includes(searchLower));
      if (!matchesSearch) return false;
    }
    // ... rest of the filter conditions remain identical (industry, certificate, etc.)
    // Keep all existing filter checks unchanged from this point onward
```

**Important:** The rest of the filter conditions inside the `return jobs.filter(job => { ... })` block stay exactly the same — only the first few lines that get `jobs` change. Keep all `activeFilters.industry`, `activeFilters.certificate`, `activeFilters.seniority`, `activeFilters.location`, `activeFilters.company`, `activeFilters.keyword`, `activeFilters.country`, `activeFilters.city`, `activeFilters.software`, `activeFilters.programmingSkill`, `activeFilters.yearsExperience`, `activeFilters.academicDegree`, `activeFilters.region`, `activeFilters.roleType`, `activeFilters.roleCategory`, and `selectedDate` checks unchanged.

Update the dependency array:
```ts
}, [statsData, selectedArchiveMonth, debouncedTextSearch, activeFilters, selectedDate, selectedDateAffectsJobs, loadedJobsById, descriptionCache]);
```

---

#### Change 4i — Simplify `filteredStatistics` — charts always use pre-computed data (Option D)

Find the `filteredStatistics` useMemo (currently around line 607). It is the large block that rebuilds statistics from `filteredJobs` when filters are active.

**Replace the entire `filteredStatistics` useMemo with:**

```ts
// Charts always show pre-computed aggregated data regardless of active filters (Option D).
// Filters only affect the jobs table (filteredJobs), not the chart distributions.
const filteredStatistics = useMemo((): MonthlyStatistics | null => {
  return getActiveStatistics();
}, [statsData, viewMode, selectedArchiveMonth]);
```

This removes the expensive rebuild-from-jobs logic entirely.

---

#### Change 4j — Remove `rebuildSalaryStats` function

The `rebuildSalaryStats` function (around line 527) was only used inside the old `filteredStatistics` rebuild. It is no longer needed. **Delete it entirely.**

---

#### Change 4k — Update the "FILTERED" metric in Key Metrics panel

Find this block in the JSX:
```tsx
<div className="metric-compact">
  <div className="metric-compact-label">FILTERED</div>
  <div className="metric-compact-value highlight">
    <AnimatedNumber value={filteredStats?.totalJobs || 0} />
  </div>
</div>
```

Replace with:
```tsx
<div className="metric-compact">
  <div className="metric-compact-label">FILTERED</div>
  <div className="metric-compact-value highlight">
    <AnimatedNumber value={filteredJobs.length} />
  </div>
  {hasActiveFilters && (
    <div className="metric-compact-sublabel">loaded days</div>
  )}
</div>
```

---

#### Change 4l — Update `PostingHeatmap` call — stop passing `filteredJobs`

Find:
```tsx
<PostingHeatmap
  jobs={filteredJobs}
  byDayHour={filteredStats?.byDayHour}
/>
```

Replace with:
```tsx
<PostingHeatmap
  jobs={[]}
  byDayHour={filteredStats?.byDayHour}
/>
```

The component already prefers `byDayHour` when present (see `PostingHeatmap.tsx` line 66: it checks `byDayHour` first). Passing an empty array is safe.

---

#### Change 4m — Update `getPublicationTimeData()` — always use pre-computed `byHour`

Find the `getPublicationTimeData` function (around line 1121). It currently checks `filteredJobs.length > 0` first and uses real job timestamps. Replace the entire function with:

```ts
const getPublicationTimeData = () => {
  const stats = filteredStats;
  if (!stats?.byHour || Object.keys(stats.byHour).length === 0) return [];
  return Object.entries(stats.byHour)
    .map(([hour, count]) => ({ time: hour.padStart(2, '0') + ':00', count }))
    .sort((a, b) => a.time.localeCompare(b.time));
};
```

---

#### Change 4n — Add "LOAD FULL MONTH" button in the Jobs Table panel header

Find the jobs table panel header:
```tsx
<div className="panel-header">
  <Briefcase size={14} />
  <span>RECENT JOBS (TOP 100)</span>
  {jobsLoading && <Loader2 size={12} className="animate-spin panel-header-spinner" />}
</div>
```

Replace with:
```tsx
<div className="panel-header">
  <Briefcase size={14} />
  <span>RECENT JOBS (TOP 100)</span>
  {(jobsLoading || fullMonthLoading) && <Loader2 size={12} className="animate-spin panel-header-spinner" />}
  {!fullMonthLoaded && !fullMonthLoading && !jobsLoading && (
    <button
      className="terminal-btn-small"
      onClick={loadFullMonth}
      title="Load all jobs for this month"
    >
      LOAD FULL MONTH
    </button>
  )}
  {fullMonthLoaded && (
    <span className="panel-header-note">FULL MONTH LOADED</span>
  )}
</div>
```

Add these CSS classes to `page.css`:
```css
.terminal-btn-small {
  font-size: 10px;
  padding: 2px 8px;
  border: 1px solid var(--accent-primary);
  background: transparent;
  color: var(--accent-primary);
  cursor: pointer;
  font-family: 'Courier New', monospace;
  margin-left: auto;
}
.terminal-btn-small:hover {
  background: var(--accent-primary);
  color: var(--bg-primary);
}
.panel-header-note {
  font-size: 10px;
  color: var(--text-muted);
  margin-left: auto;
}
```

---

#### Change 4o — Update the job description popup to fetch on-demand

Find the hover popup JSX (around line 2144):
```tsx
{hoveredJob && popupPosition && (
  <div ... >
    ...
    <div dangerouslySetInnerHTML={{ __html: hoveredJob.description }} />
  </div>
)}
```

Change the popup content area:
```tsx
{hoveredJob && popupPosition && (
  <div ... >
    <div className="job-popup-header"> ... </div>
    <div className="job-popup-content" onWheel={(e) => e.stopPropagation()}>
      {(() => {
        const desc = descriptionCache.get(hoveredJob.id) || hoveredJob.description;
        const dateKey = hoveredJob.extractedDate?.split('T')[0];
        const isLoadingThisDate = loadingDescriptionsDate === dateKey;

        if (desc) {
          return <div dangerouslySetInnerHTML={{ __html: desc }} />;
        }
        if (isLoadingThisDate) {
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 16 }}>
              <Loader2 size={16} className="spin" />
              <span>Loading description...</span>
            </div>
          );
        }
        // Trigger load if not already loading
        if (dateKey && !isLoadingThisDate) {
          loadDescriptionsForDate(dateKey);
        }
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 16 }}>
            <Loader2 size={16} className="spin" />
            <span>Loading description...</span>
          </div>
        );
      })()}
    </div>
  </div>
)}
```

**Important note:** The `loadDescriptionsForDate` call inside the render is a side-effect in render, which is a React anti-pattern. To avoid this, instead trigger the description fetch in the `hoverTimerRef` timeout where `setHoveredJob` is called:

Find the hover timer inside `onMouseEnter`:
```ts
hoverTimerRef.current = setTimeout(() => {
  setHoveredJob(job);
  setPopupPosition({ ... });
}, 3000);
```

Replace with:
```ts
hoverTimerRef.current = setTimeout(() => {
  setHoveredJob(job);
  setPopupPosition({ x: window.innerWidth / 2 - 200, y: window.innerHeight / 2 - 250 });
  // Trigger description fetch for this job's date
  const dateKey = job.extractedDate?.split('T')[0];
  if (dateKey) {
    loadDescriptionsForDate(dateKey);
  }
}, 3000);
```

And simplify the popup content to just check the cache:
```tsx
<div className="job-popup-content" onWheel={(e) => e.stopPropagation()}>
  {(() => {
    const desc = descriptionCache.get(hoveredJob.id) || hoveredJob.description;
    const dateKey = hoveredJob.extractedDate?.split('T')[0];
    const isLoading = loadingDescriptionsDate === dateKey && !desc;
    if (isLoading) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 16 }}>
          <Loader2 size={16} className="spin" />
          <span>Loading description...</span>
        </div>
      );
    }
    return <div dangerouslySetInnerHTML={{ __html: desc || '<p>No description available.</p>' }} />;
  })()}
</div>
```

---

#### Change 4p — Update dependency arrays and remove stale useMemo

Find `marketInsights` useMemo (around line 903):
```ts
}, [statsData, filteredStatistics]);
```
Keep as is — `filteredStatistics` is still referenced (it just returns pre-computed data now).

Find `availableFilterOptions` useMemo. It currently references `useAggregated` and `selectedArchiveMonth`. Keep this unchanged — filter options still come from pre-computed stats.

---

#### Change 4q — Clean up references to `statsData.currentMonth.jobs`

Search for any remaining references to `statsData.currentMonth.jobs` in `page.tsx` and remove them. After the changes above, `jobs` is no longer stored in `statsData` — it lives in `loadedJobsById`. The `StatsData` interface can also have the `jobs?` field removed from `currentMonth`.

In the `StatsData` interface (around line 99):
```ts
interface StatsData {
  currentMonth: {
    month: string;
    lastUpdated: string;
    jobCount: number;
    statistics: MonthlyStatistics;
    jobs?: JobStatistic[]; // ← REMOVE THIS LINE
  };
  ...
}
```

---

### FILE 5: `src/components/SearchFilterPanel.tsx`

#### Change 5a — Add `selectedDate` prop and description search hint

Add `selectedDate` and `onDateClear` to the props interface:

```ts
interface SearchFilterPanelProps {
  activeFilters: ActiveFilters;
  setActiveFilters: (filters: ActiveFilters) => void;
  availableOptions: Record<keyof ActiveFilters, FilterOption[]>;
  textSearch: string;
  setTextSearch: (search: string) => void;
  selectedDate: string | null;          // ADD
  loadingDescriptions?: boolean;         // ADD — true while fetching descriptions
}
```

Inside the component, add a hint below the search input that appears when text search is active but no date is selected:

Find the search input container in the JSX:
```tsx
<div className="search-input-container">
  <Search size={16} />
  <input ... />
  {textSearch && <button ...><X size={14} /></button>}
</div>
```

Add below it (still inside `search-filter-header`):
```tsx
{textSearch && !selectedDate && (
  <div className="search-date-hint">
    <span>Select a date on the velocity chart to also search descriptions</span>
  </div>
)}
{textSearch && selectedDate && loadingDescriptions && (
  <div className="search-date-hint loading">
    <Loader2 size={12} className="spin" />
    <span>Loading descriptions for {selectedDate}…</span>
  </div>
)}
{textSearch && selectedDate && !loadingDescriptions && (
  <div className="search-date-hint ready">
    <span>Searching metadata + descriptions for {selectedDate}</span>
  </div>
)}
```

Add `Loader2` to the lucide-react imports at the top of `SearchFilterPanel.tsx`.

Add to `SearchFilterPanel.css`:
```css
.search-date-hint {
  font-size: 10px;
  color: var(--text-muted);
  padding: 4px 8px;
  font-family: 'Courier New', monospace;
}
.search-date-hint.loading {
  color: var(--accent-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
}
.search-date-hint.ready {
  color: var(--accent-primary);
}
```

---

#### Change 5b — Pass new props from `page.tsx` to `SearchFilterPanel`

Find the `SearchFilterPanel` usage in `page.tsx`:
```tsx
<SearchFilterPanel
  activeFilters={activeFilters}
  setActiveFilters={setActiveFilters}
  availableOptions={availableFilterOptions}
  textSearch={textSearch}
  setTextSearch={setTextSearch}
/>
```

Replace with:
```tsx
<SearchFilterPanel
  activeFilters={activeFilters}
  setActiveFilters={setActiveFilters}
  availableOptions={availableFilterOptions}
  textSearch={textSearch}
  setTextSearch={setTextSearch}
  selectedDate={selectedDate}
  loadingDescriptions={loadingDescriptionsDate !== null}
/>
```

---

## Component Data Reference (for understanding what feeds what)

### Charts — always pre-computed, never touch job records after this change

| Component | Input field | Source |
|---|---|---|
| `PostingVelocity` (ComposedChart) | `filteredStatistics.byDate` | `aggregated-stats.json` (ALL mode) or `stats/YYYY-MM.json` (CURRENT/archive) |
| `IndustryTreemap` | `filteredStatistics.byIndustry` | same |
| `Seniority` (PieChart) | `filteredStatistics.bySeniority` | same |
| `PostingHeatmap` | `byDayHour={filteredStats?.byDayHour}`, `jobs={[]}` | same |
| `PublicationTimes` (BarChart) | `filteredStatistics.byHour` | same |
| `CertsBump` | `filteredStatistics.byCertificate` | same |
| `RegionalDistribution` (PieChart) | `filteredStatistics.byRegion` | same |
| `TopEmployers` (BarChart) | `filteredStatistics.byCompany` | same |
| `WorldMap` | `filteredStatistics.byCountry` | same |
| `TopCities` (BarChart) | `filteredStatistics.byCity` | same |
| `ExperienceRequired` (BarChart) | `filteredStatistics.byYearsExperience` | same |
| `DegreesRequired` (PieChart) | `filteredStatistics.byAcademicDegree` | same |
| `SoftwareTools` (tag buttons) | `filteredStatistics.bySoftware` | same |
| `ProgrammingLanguages` (tag buttons) | `filteredStatistics.byProgrammingSkill` | same |
| `JobCategories` (PieChart) | `filteredStatistics.byRoleCategory` | same |
| `TopRoleTypes` (BarChart + tags) | `filteredStatistics.byRoleType` | same |
| `KeywordAnalysis` table + `SkillsTagCloud` | `filteredStatistics.byKeyword` | same |
| `ComprehensiveStatistics` table | all `filteredStats.*` fields | same |

### Jobs Table & Descriptions — use loaded individual records

| Component | Input | Source |
|---|---|---|
| `RecentJobs` table | `filteredJobs` (filtered from `loadedJobsById`) | `metadata/YYYY/MM/day-DD.ndjson.gz` (last 3 days on load, more on demand) |
| `JobDescriptionPopup` | `descriptionCache.get(hoveredJob.id)` | `descriptions/YYYY/MM/day-DD.ndjson.gz` (fetched on hover after 3s delay) |

### Key Metrics — mix of sources

| Metric | Source |
|---|---|
| TOTAL | `statsData.summary.totalJobsAllTime` (from `aggregated-stats.json`) |
| THIS MONTH | `statsData.currentMonth.jobCount` (from `manifest.json`) |
| AVG/MONTH | `statsData.summary.overallStatistics.averageJobsPerMonth` (from `aggregated-stats.json`) |
| FILTERED | `filteredJobs.length` (count of loaded records matching active filters) |
| ARCHIVES | `statsData.summary.availableArchives.length` (from `manifest.json`) |

### `SearchFilterPanel` — filter options from pre-computed stats only

| Input prop | Value |
|---|---|
| `availableOptions` | Built from `filteredStatistics.*` maps (pre-computed, not from job records) |
| `textSearch` / `setTextSearch` | Page-level state |
| `selectedDate` | `selectedDate` state from page (set by clicking velocity chart) |
| `loadingDescriptions` | `loadingDescriptionsDate !== null` |

---

## API Endpoints After This Change

| Endpoint | When called | R2 reads | Response size |
|---|---|---|---|
| `GET /api/stats/load` | On page mount + LOAD DATA button | manifest + url-index + stats/current + aggregated-stats | ~150KB |
| `GET /api/stats/jobs?month=X&days=3` | Background after page load | 3 metadata files | ~450KB |
| `GET /api/stats/jobs?month=X&date=YYYY-MM-DD` | On velocity chart date click | 1 metadata file | ~150KB |
| `GET /api/stats/jobs?month=X&all=true` | On "LOAD FULL MONTH" button | all metadata files for month | up to ~4.5MB |
| `GET /api/stats/description?date=YYYY-MM-DD` | On job hover (3s delay) or text search + date | 1 descriptions file | ~1.5MB |

vs. **before**: every page load triggered ~25 R2 reads and up to 7.5MB of descriptions.

---

## Files to Create
- `src/app/api/stats/description/route.ts` (new)

## Files to Modify
- `src/lib/job-statistics-r2.ts`
- `src/app/api/stats/jobs/route.ts`
- `src/app/page.tsx`
- `src/components/SearchFilterPanel.tsx`
- `src/components/SearchFilterPanel.css` (add `.search-date-hint` styles)
- `src/app/page.css` (add `.terminal-btn-small` and `.panel-header-note` styles)
