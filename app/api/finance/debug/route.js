import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";
import { hasFinanceScope, shopAccess } from "../../../../lib/tiktok";
import { AD_FEE_KEYS, fetchSettlements } from "../../../../lib/tiktok-finance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/finance/debug?days=90
 *
 * Confirms the Finance field mapping against the live shop without writing
 * anything. Open it in the browser while signed in.
 *
 * What to look at:
 *   financeScope      false  -> the Finance permission was never granted
 *   statements        0      -> no payouts in the window (or scope missing)
 *   settlementDrift   ~0     -> TikTok's own identity reconciles; mapping is right
 *   adFeeTotal               -> GMV Max ad spend we can sync
 *   unmappedFeeKeys          -> fee keys TikTok sent that have no label yet
 *   orphanAdjustments        -> adjustments with no order, excluded from Duit Masuk
 */
export async function GET(request) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

    const access = await shopAccess(user.workspace_id);
    if (!access.ok) return NextResponse.json({ ok: false, reason: access.reason, detail: access.detail || null }, { status: 409 });

    const { searchParams } = new URL(request.url);
    const days = Math.min(Math.max(Number(searchParams.get("days")) || 90, 1), 365);
    const result = await fetchSettlements({
      accessToken: access.accessToken,
      shopCipher: access.shopCipher,
      statementTimeGe: Math.floor(Date.now() / 1000) - days * 86400,
      maxTransactions: 500,
    });

    const drift = result.rows.reduce(
      (sum, row) => sum + row.settlementAmount - (row.revenueAmount + row.feeTaxAmount + row.shippingCostAmount + row.adjustmentAmount),
      0,
    );
    const adFeeTotal = result.rows.reduce((sum, row) => sum + row.adFeeAmount, 0);

    // Which fee keys actually appear for this shop, and how much each is worth.
    const feeKeys = {};
    for (const row of result.rows) {
      for (const line of row.breakdown) {
        const id = `${line.group}.${line.key}`;
        feeKeys[id] = Number(((feeKeys[id] || 0) + line.amount).toFixed(2));
      }
    }

    return NextResponse.json({
      ok: true,
      shop: { name: access.sellerName, region: access.region, shopId: access.shopId },
      financeScope: hasFinanceScope(access.grantedPermissions),
      grantedPermissions: access.grantedPermissions,
      windowDays: days,
      statements: result.statements.length,
      transactions: result.rows.length,
      truncated: result.truncated,
      apiError: result.error || null,
      settlementTotal: Number(result.rows.reduce((sum, row) => sum + row.settlementAmount, 0).toFixed(2)),
      settlementDrift: Number(drift.toFixed(2)),
      adFeeTotal: Number(adFeeTotal.toFixed(2)),
      adFeeKeysWatched: AD_FEE_KEYS,
      feeKeysSeen: feeKeys,
      orphanAdjustments: result.rows.filter((row) => row.type && row.type !== "ORDER" && !row.raw.order_id).length,
      sampleStatement: result.statements[0] || null,
      sampleTransaction: result.sampleTransaction || null,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Debug failed." }, { status: 500 });
  }
}
