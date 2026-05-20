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

    const entries = Array.from(descMap.entries()) as Array<[string, string]>;
    const descriptions = entries.map(([id, description]) => ({ id, description }));

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
