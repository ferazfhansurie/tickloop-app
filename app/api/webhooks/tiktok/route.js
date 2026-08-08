import { NextResponse } from "next/server";
import { logWebhook, saveOrders } from "../../../../lib/finance";
import { getOrderDetail, normalizeOrder, shopAccess, verifyWebhook, workspaceForShop } from "../../../../lib/tiktok";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * TikTok Shop webhook receiver — the live half of the sync.
 *
 * Order events arrive within seconds of the buyer acting, so sales on the
 * dashboard stay current without polling. Settlements have no webhook of their
 * own (TikTok closes payout statements in batches), so those still come from the
 * scheduled sync in /api/finance/cron.
 *
 * Register this URL in Partner Center > your app > Webhooks, for
 * ORDER_STATUS_UPDATE (type 1).
 */

const ORDER_STATUS_UPDATE = 1;

export async function POST(request) {
  // The raw body must be read before parsing — the signature covers the exact bytes.
  const raw = await request.text();
  let peek = {};
  try { peek = JSON.parse(raw); } catch { /* logged below as malformed */ }

  if (!verifyWebhook(raw, request.headers.get("authorization"))) {
    // Logged, not just rejected: a signature mismatch is otherwise invisible from
    // this side and reads as "the dashboard stopped updating".
    await logWebhook({ eventType: String(peek.type ?? "?"), shopId: peek.shop_id, orderId: peek.data?.order_id, verified: false, outcome: "bad_signature" });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload;
  try { payload = JSON.parse(raw); } catch {
    await logWebhook({ verified: true, outcome: "malformed_body" });
    return NextResponse.json({ error: "Malformed body" }, { status: 400 });
  }

  const shopId = payload.shop_id ? String(payload.shop_id) : null;
  const orderId = payload.data?.order_id ? String(payload.data.order_id) : null;
  const type = Number(payload.type);

  // Anything other than an order update is acknowledged and ignored: returning a
  // non-2xx makes TikTok retry an event we were never going to act on.
  if (type !== ORDER_STATUS_UPDATE || !orderId || !shopId) {
    await logWebhook({ eventType: String(type), shopId, orderId, verified: true, outcome: "ignored" });
    return NextResponse.json({ received: true, ignored: true });
  }

  const workspaceId = await workspaceForShop(shopId);
  if (!workspaceId) {
    await logWebhook({ eventType: String(type), shopId, orderId, verified: true, outcome: "unknown_shop" });
    return NextResponse.json({ received: true, unknownShop: true });
  }

  try {
    const access = await shopAccess(workspaceId);
    if (!access.ok) {
      await logWebhook({ eventType: String(type), shopId, orderId, verified: true, outcome: "deferred", note: access.reason });
      return NextResponse.json({ received: true, deferred: access.reason });
    }

    // The event carries only the new status, so pull the order for its line items
    // and amount — the dashboard needs both to count the sale.
    const detail = await getOrderDetail({ accessToken: access.accessToken, shopCipher: access.shopCipher, ids: [orderId] });
    const orders = detail.data?.orders || [];
    if (orders.length) await saveOrders(workspaceId, orders.map(normalizeOrder));
    await logWebhook({ eventType: String(type), shopId, orderId, verified: true, outcome: orders.length ? "updated" : "no_order_returned", note: orders[0]?.status });
    return NextResponse.json({ received: true, updated: orders.length });
  } catch (error) {
    // Never fail the webhook on a downstream problem: TikTok retries non-2xx, and
    // the scheduled sync will pick the order up regardless.
    console.error("[finance] webhook hydrate failed", orderId, error);
    await logWebhook({ eventType: String(type), shopId, orderId, verified: true, outcome: "hydrate_failed", note: String(error?.message || "").slice(0, 200) }).catch(() => {});
    return NextResponse.json({ received: true, deferred: "hydrate_failed" });
  }
}

/** Partner Center pings the URL before saving it. */
export async function GET() {
  return NextResponse.json({ ok: true });
}
