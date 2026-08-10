import { NextResponse } from "next/server";
import { database, ensureSchema } from "../../../../lib/db";
import { saveAdTransactions, saveAttributions, saveOrders, saveSettlements, syncedStatementIds } from "../../../../lib/finance";
import { normalizeOrder, searchAllOrders, shopAccess } from "../../../../lib/tiktok";
import { fetchSettlements } from "../../../../lib/tiktok-finance";
import { fetchAffiliateOrders } from "../../../../lib/tiktok-affiliate";
import { businessAccess, fetchAdTransactions } from "../../../../lib/tiktok-business";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Scheduled sync for every connected shop.
 *
 * Settlements are the reason this exists: TikTok has no finance webhook, and
 * payouts land whenever a statement closes, so the only way Duit Masuk stays
 * current is to poll. Orders arrive by webhook within seconds, but they are
 * re-synced on a short window here too, so a missed or unregistered webhook
 * cannot leave the dashboard quietly stale.
 *
 * Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization");
  // Refuse to run unauthenticated: this endpoint spends TikTok API quota.
  if (!secret || provided !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureSchema();
  const q = database();
  const connections = await q`SELECT workspace_id FROM tl_connections WHERE provider='tiktok_shop' AND status='connected' AND credentials IS NOT NULL`;

  const { searchParams } = new URL(request.url);
  // Short order window on a schedule — the deep 90-day walk is a manual action.
  const orderDays = Math.min(Math.max(Number(searchParams.get("days")) || 7, 1), 90);
  const statementDays = Math.min(Math.max(Number(searchParams.get("statementDays")) || 60, 1), 365);

  const results = [];
  for (const connection of connections) {
    const workspaceId = connection.workspace_id;
    const result = { workspaceId, orders: 0, settlements: 0, errors: [] };
    try {
      const access = await shopAccess(workspaceId);
      if (!access.ok) {
        result.errors.push(access.reason);
        results.push(result);
        continue;
      }

      const orderResult = await searchAllOrders({
        accessToken: access.accessToken,
        shopCipher: access.shopCipher,
        createTimeGe: Math.floor(Date.now() / 1000) - orderDays * 86400,
      });
      if (orderResult.error) result.errors.push(`orders: ${orderResult.error}`);
      const orders = (orderResult.orders || []).map(normalizeOrder);
      if (orders.length) await saveOrders(workspaceId, orders);
      result.orders = orders.length;

      // Statements already stored are skipped, so each run only reads new payouts.
      const settlementResult = await fetchSettlements({
        accessToken: access.accessToken,
        shopCipher: access.shopCipher,
        statementTimeGe: Math.floor(Date.now() / 1000) - statementDays * 86400,
        skipStatementIds: await syncedStatementIds(workspaceId),
      });
      if (settlementResult.error) result.errors.push(`settlements: ${settlementResult.error}`);
      if (settlementResult.rows.length) await saveSettlements(workspaceId, settlementResult.rows);
      result.settlements = settlementResult.rows.length;
      result.statementsSkipped = settlementResult.skipped || 0;

      // Creator attribution, same window as orders. Optional scope: a shop
      // without it should not fail the run.
      const affiliate = await fetchAffiliateOrders({
        accessToken: access.accessToken,
        shopCipher: access.shopCipher,
        createTimeGe: Math.floor(Date.now() / 1000) - orderDays * 86400,
      });
      if (affiliate.error) result.errors.push(`affiliate: ${affiliate.error}`);
      if (affiliate.rows.length) await saveAttributions(workspaceId, affiliate.rows);
      result.attributions = affiliate.rows.length;

      // Business Center is optional and independent: a workspace without it must
      // not turn the whole run into an error.
      const business = await businessAccess(workspaceId);
      if (business.ok && business.bcId) {
        const end = new Date();
        const start = new Date(end.getTime() - 60 * 86400000);
        const ads = await fetchAdTransactions({
          accessToken: business.accessToken,
          bcId: business.bcId,
          startDate: start.toISOString().slice(0, 10),
          endDate: end.toISOString().slice(0, 10),
        });
        if (ads.error) result.errors.push(`ads: ${ads.error}`);
        if (ads.rows.length) await saveAdTransactions(workspaceId, ads.rows);
        result.adTransactions = ads.rows.length;
      }
    } catch (error) {
      result.errors.push(error.message || "unknown");
    }
    results.push(result);
  }

  return NextResponse.json({ ran: results.length, results });
}
