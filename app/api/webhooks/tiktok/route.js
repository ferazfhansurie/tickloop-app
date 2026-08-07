import { NextResponse } from "next/server";
import { saveOrders } from "../../../../lib/finance";
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
  if (!verifyWebhook(raw, request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload;
  try { payload = JSON.parse(raw); } catch { return NextResponse.json({ error: "Malformed body" }, { status: 400 }); }

  const shopId = payload.shop_id ? String(payload.shop_id) : null;
  const orderId = payload.data?.order_id ? String(payload.data.order_id) : null;
  const type = Number(payload.type);

  // Anything other than an order update is acknowledged and ignored: returning a
  // non-2xx makes TikTok retry an event we were never going to act on.
  if (type !== ORDER_STATUS_UPDATE || !orderId || !shopId) return NextResponse.json({ received: true, ignored: true });

  const workspaceId = await workspaceForShop(shopId);
  if (!workspaceId) return NextResponse.json({ received: true, unknownShop: true });

  try {
    const access = await shopAccess(workspaceId);
    if (!access.ok) return NextResponse.json({ received: true, deferred: access.reason });

    // The event carries only the new status, so pull the order for its line items
    // and amount — the dashboard needs both to count the sale.
    const detail = await getOrderDetail({ accessToken: access.accessToken, shopCipher: access.shopCipher, ids: [orderId] });
    const orders = detail.data?.orders || [];
    if (orders.length) await saveOrders(workspaceId, orders.map(normalizeOrder));
    return NextResponse.json({ received: true, updated: orders.length });
  } catch (error) {
    // Never fail the webhook on a downstream problem: TikTok retries non-2xx, and
    // the scheduled sync will pick the order up regardless.
    console.error("[finance] webhook hydrate failed", orderId, error);
    return NextResponse.json({ received: true, deferred: "hydrate_failed" });
  }
}

/** Partner Center pings the URL before saving it. */
export async function GET() {
  return NextResponse.json({ ok: true });
}
