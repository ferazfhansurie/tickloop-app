import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";
import { financeSummary, repairBreakdowns } from "../../../../lib/finance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/finance/repair
 *
 * Removes restated lines from settlement breakdowns already stored. Pure SQL, so
 * it finishes in a second — unlike ?refresh=1, which re-reads every statement
 * from TikTok and times out on a shop with thousands of transactions.
 */
export async function POST(request) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

    const result = await repairBreakdowns(user.workspace_id);

    // Report the reconciliation so the caller can see it actually worked.
    const now = new Date();
    const summary = await financeSummary(
      user.workspace_id,
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
    );
    return NextResponse.json({ ...result, lineDrift: summary.lineDrift, settlementDrift: summary.settlementDrift });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Repair failed." }, { status: 500 });
  }
}
