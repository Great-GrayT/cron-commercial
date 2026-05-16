import { NextRequest, NextResponse } from "next/server";
import { getStatsCache } from "@/lib/stats-storage";
import { validateEnvironmentVariables } from "@/lib/validation";
import { logger } from "@/lib/logger";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * GET /api/stats/jobs?month=YYYY-MM
 *
 * Returns individual job records for the requested month.
 * Intentionally kept separate from /api/stats/load to keep that response
 * small and fast (no Vercel 4.5 MB response cap issues).
 */
export async function GET(request: NextRequest) {
  try {
    validateEnvironmentVariables();

    const month = request.nextUrl.searchParams.get("month");
    if (!month) {
      return NextResponse.json(
        { error: "Missing required query parameter: month (YYYY-MM)" },
        { status: 400 }
      );
    }

    const statsCache = await getStatsCache();
    await statsCache.load();

    if (typeof statsCache.loadJobsForMonth !== "function") {
      return NextResponse.json({ success: true, month, jobs: [] });
    }

    logger.info(`Loading jobs for month: ${month}`);
    const jobs = await statsCache.loadJobsForMonth(month);

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
