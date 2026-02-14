import { NextRequest, NextResponse } from "next/server";
import { getStatsCache, getStorageInfo } from "@/lib/stats-storage";
import { validateEnvironmentVariables } from "@/lib/validation";
import { logger } from "@/lib/logger";

export const maxDuration = 300; // 5 minutes timeout
export const dynamic = "force-dynamic";

/**
 * GET /api/stats/load
 *
 * Loads statistics from GitHub Gist without updating
 * Returns current month data with full job details and aggregated statistics
 */
export async function GET(request: NextRequest) {
  try {
    // Validate environment variables
    validateEnvironmentVariables();

    // Get query parameters
    const searchParams = request.nextUrl.searchParams;
    const archive = searchParams.get("archive"); // Optional: specific month (YYYY-MM)
    const page = parseInt(searchParams.get("page") || "1", 10);
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 500);
    const includeJobs = searchParams.get("jobs") !== "false"; // Default: include jobs

    // Initialize statistics cache (auto-selects R2 or Gist based on config)
    const statsCache = await getStatsCache();
    await statsCache.load();

    const storageInfo = getStorageInfo();

    // If requesting archived month
    if (archive) {
      logger.info(`Fetching archived month: ${archive}`);
      const archivedData = await statsCache.getArchivedMonth(archive);

      if (!archivedData) {
        return NextResponse.json(
          {
            error: "Archive not found",
            message: `No archived data found for ${archive}`,
          },
          { status: 404 }
        );
      }

      return NextResponse.json({
        success: true,
        type: "archive",
        month: archive,
        data: archivedData,
      });
    }

    // Return current month data, summary, AND aggregated historical data
    // Note: getCurrentMonthData may be async (R2) or sync (Gist), so we await it
    const currentMonthData = await Promise.resolve(statsCache.getCurrentMonthData());
    const summary = statsCache.getSummary();
    const stats = statsCache.getStats();

    // Get aggregated data from ALL archived months + current month
    logger.info('Loading and aggregating all archived months...');
    const aggregatedResult = await statsCache.getAllArchivesAggregated();
    const archives = aggregatedResult?.archives || [];
    const aggregated = aggregatedResult?.aggregated || {};
    const totalJobs = aggregatedResult?.totalJobs || 0;

    return NextResponse.json({
      success: true,
      type: "current",
      currentMonth: {
        month: currentMonthData.month,
        lastUpdated: currentMonthData.lastUpdated,
        jobCount: currentMonthData.jobs?.length || 0,
        statistics: currentMonthData.statistics,
        jobs: currentMonthData.jobs || [], // Include full job data for current month
      },
      summary: {
        totalJobsAllTime: totalJobs, // Use aggregated total
        currentMonth: summary.currentMonth,
        availableArchives: summary.availableArchives,
        overallStatistics: summary.overallStatistics,
      },
      // Aggregated statistics from ALL months (historical + current)
      aggregated: {
        totalJobs: totalJobs,
        statistics: aggregated,
        monthsIncluded: archives.length + 1, // +1 for current month
        archives: archives.map((a: { month: string; jobCount: number }) => ({
          month: a.month,
          jobCount: a.jobCount,
        })),
      },
      stats: {
        ...stats,
        storageBackend: storageInfo.backend,
      },
    });
  } catch (error) {
    logger.error("Error fetching statistics:", error);

    return NextResponse.json(
      {
        error: "Failed to fetch statistics",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
