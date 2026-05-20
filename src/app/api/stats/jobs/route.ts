import { NextRequest, NextResponse } from "next/server";
import { getStatsCache } from "@/lib/stats-storage";
import { validateEnvironmentVariables } from "@/lib/validation";
import { logger } from "@/lib/logger";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * GET /api/stats/jobs?month=YYYY-MM[&days=N][&date=YYYY-MM-DD][&all=true]
 *
 * Returns job metadata (no descriptions) for the requested month.
 *
 * Query parameters:
 *   month (required) - YYYY-MM
 *   days  (optional) - load only the last N days. Default: 3.
 *   date  (optional) - load only this specific date (YYYY-MM-DD). Overrides days.
 *   all   (optional) - if "true", load all days. For "Load Full Month" button.
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

    let options: { days?: number; date?: string } = { days: 3 };

    if (dateParam) {
      options = { date: dateParam };
    } else if (allParam) {
      options = {};
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
