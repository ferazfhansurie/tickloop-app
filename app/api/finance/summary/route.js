import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";
import { OPEX_TEMPLATE, discoverSkus, financeSummary, lastSyncedAt, listOpex, listPeriodCosts, listProductCosts, saveOrders, saveSettlements, syncedStatementIds } from "../../../../lib/finance";
import { hasFinanceScope, normalizeOrder, searchAllOrders, shopAccess } from "../../../../lib/tiktok";
import { fetchSettlements } from "../../../../lib/tiktok-finance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A first sync walks ~90 days of orders and every payout statement behind them,
// which is comfortably more than the 60s default allows on a busy shop.
export const maxDuration = 300;

// A message per shopAccess failure, so the dashboard never shows a bare error code.
const ACCESS_MESSAGES = {
  not_connected: "TikTok Shop is not connected yet. Connect it from the setup panel.",
  not_configured: "TikTok credentials are not configured on the server.",
  unreadable_credentials: "The stored TikTok credentials could not be read. Reconnect the shop.",
  token_expired: "The TikTok authorization expired. Reconnect the shop.",
  refresh_failed: "TikTok refused to refresh the access token. Reconnect the shop.",
  shop_lookup_failed: "Could not read the authorized shop from TikTok.",
  no_authorized_shop: "No authorized shop came back from TikTok.",
};

function monthBounds(searchParams) {
  const now = new Date();
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (from && to) return { fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString() };
  // Default to the current calendar month, which is how the seller reconciles.
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { fromIso: start.toISOString(), toIso: end.toISOString() };
}

/**
 * GET /api/finance/summary
 *   ?from=&to=   ISO dates (default: current calendar month)
 *   ?sync=1      pull fresh orders + settlements from TikTok first
 *   ?days=90     how far back to sync (TikTok caps order windows at 90 days)
 */
export async function GET(request) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const { fromIso, toIso } = monthBounds(searchParams);
    const wantsSync = searchParams.get("sync") === "1";

    let sync;
    if (wantsSync) {
      const access = await shopAccess(user.workspace_id);
      if (!access.ok) {
        return NextResponse.json({ error: ACCESS_MESSAGES[access.reason] || access.reason, reason: access.reason, detail: access.detail || null }, { status: 409 });
      }

      // `only` lets each half be re-run alone. A slow order walk must never
      // starve the settlement sync, which is the half that carries the money.
      const only = searchParams.get("only");
      const doOrders = only !== "settlements";
      const doSettlements = only !== "orders";

      const days = Math.min(Math.max(Number(searchParams.get("days")) || 90, 1), 90);
      const errors = [];
      let orders = [];
      let orderResult = {};

      if (doOrders) {
        orderResult = await searchAllOrders({
          accessToken: access.accessToken,
          shopCipher: access.shopCipher,
          createTimeGe: Math.floor(Date.now() / 1000) - days * 86400,
        });
        if (orderResult.error) errors.push(`Orders: ${orderResult.error}`);
        orders = (orderResult.orders || []).map(normalizeOrder);
        if (orders.length) await saveOrders(user.workspace_id, orders);
      }

      const financeScope = hasFinanceScope(access.grantedPermissions);
      let settlementResult = { rows: [], statements: [] };
      if (doSettlements) {
        // Resume: skip statements already stored unless ?refresh=1 forces a re-read.
        const skipStatementIds = searchParams.get("refresh") === "1" ? null : await syncedStatementIds(user.workspace_id);
        settlementResult = await fetchSettlements({
          accessToken: access.accessToken,
          shopCipher: access.shopCipher,
          statementTimeGe: Math.floor(Date.now() / 1000) - Math.min(Math.max(Number(searchParams.get("statementDays")) || 180, 1), 365) * 86400,
          skipStatementIds,
        });
        if (settlementResult.error) {
          errors.push(financeScope === false
            ? `Settlements: ${settlementResult.error}. The Finance permission was not granted at authorization — reconnect the shop and approve it.`
            : `Settlements: ${settlementResult.error}`);
        }
        if (settlementResult.rows.length) await saveSettlements(user.workspace_id, settlementResult.rows);
      }

      sync = {
        orders: orders.length,
        ordersTruncated: Boolean(orderResult.truncated),
        settlements: settlementResult.rows.length,
        statements: settlementResult.statements.length,
        settlementsTruncated: settlementResult.truncated,
        statementsSkipped: settlementResult.skipped || 0,
        sellerName: access.sellerName,
        financeScope,
        errors,
      };
    }

    const summary = await financeSummary(user.workspace_id, fromIso, toIso);
    const [productCosts, periodCosts, skus, lastSynced] = await Promise.all([
      listProductCosts(user.workspace_id),
      listPeriodCosts(user.workspace_id),
      discoverSkus(user.workspace_id),
      lastSyncedAt(user.workspace_id),
    ]);

    // The editor edits one month; the summary may span several, so send the rows
    // for the range's first month rather than a merged view that cannot be saved.
    const opexRows = await listOpex(user.workspace_id, summary.periods[0]);
    return NextResponse.json({ ...summary, productCosts, periodCosts, skus, lastSynced, opexRows, opexTemplate: OPEX_TEMPLATE, ...(sync ? { sync } : {}) });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Could not build the summary." }, { status: 500 });
  }
}
