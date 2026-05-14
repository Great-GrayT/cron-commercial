# Changes

## Fix: HTTP 500 on `/api/stats/load` — partial R2 failure no longer crashes aggregation

**File:** `src/lib/job-statistics-r2.ts` — `computeAggregatedStats()` (~line 934)

### Problem

`computeAggregatedStats()` used `Promise.all()` to fetch statistics for every archived month from Cloudflare R2 in parallel. If any single month's stats file failed to load (network blip, R2 rate limit, corrupted file), `Promise.all()` rejected immediately and the entire call threw — bubbling up to a 500 in `/api/stats/load`.

### Fix

Replaced `Promise.all()` with `Promise.allSettled()`. Failed months are now logged as warnings and skipped; successfully loaded months are still aggregated and returned. The response is partial rather than absent.

### Trade-off

If a month fails to load its stats will be absent from the aggregated response for that request. This is acceptable for a dashboard — showing most data is better than showing an error. The warning log identifies which months failed for follow-up.
