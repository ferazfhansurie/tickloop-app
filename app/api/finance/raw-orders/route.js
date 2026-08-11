import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";
import { database, ensureSchema } from "../../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/finance/raw-orders
 *
 * Returns individual synced orders with their raw TikTok order id, product id
 * and SKU id untouched — no aggregation. This exists so App Review evidence can
 * show a real TikTok-format id on screen (order ids: 18 digits starting 57/58;
 * product ids starting 17), which a dashboard of totals never does.
 */
export async function GET(request) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  await ensureSchema();
  const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit")) || 20, 1), 100);
  const rows = await database()`SELECT order_id, status, currency, total_amount, create_time, items
    FROM tl_shop_orders WHERE workspace_id=${user.workspace_id} ORDER BY create_time DESC LIMIT ${limit}`;

  const orders = rows.map((row) => ({
    orderId: row.order_id,
    status: row.status,
    currency: row.currency,
    totalAmount: row.total_amount,
    createTime: row.create_time,
    items: (row.items || []).map((item) => ({ productId: item.productId, skuId: item.skuId, productName: item.productName, quantity: item.quantity })),
  }));

  return NextResponse.json({ count: orders.length, orders });
}
