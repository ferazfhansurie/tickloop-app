import { callShop } from "./tiktok";

/**
 * Affiliate orders from TikTok Shop directly.
 *
 * Creator attribution turns out to be available after all — /affiliate_seller/
 * 202410/orders/search returns creator_username, content_type and commission per
 * SKU. So the CSV upload is a fallback rather than the only way in, and stays
 * useful for backfilling beyond the API's window or for shops without the scope.
 *
 * Note the shape: attribution lives on each SKU line, not the order, so an order
 * is collapsed to one creator here the same way the CSV import does it.
 */

/** One page of affiliate orders in a create-time window. */
export function searchAffiliateOrders({ accessToken, shopCipher, createTimeGe, createTimeLt, pageToken, pageSize = 50 }) {
  const body = {};
  if (createTimeGe) body.create_time_ge = createTimeGe;
  if (createTimeLt) body.create_time_lt = createTimeLt;
  return callShop({
    path: "/affiliate_seller/202410/orders/search",
    method: "POST",
    query: { shop_cipher: shopCipher, page_size: pageSize, page_token: pageToken },
    body,
    accessToken,
  });
}

const money = (value) => {
  const parsed = Number(value?.amount ?? value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Collapses an affiliate order to a single attribution.
 *
 * A creator can appear on several SKU lines of one order; counting each line
 * would multiply that order's revenue across the leaderboard. Commission is
 * summed across lines, the creator taken from the first that names one.
 */
export function normalizeAffiliateOrder(order) {
  const skus = order.skus || [];
  const named = skus.find((sku) => sku.creator_username);
  if (!order.id || !named) return null;
  let commissionBase = 0;
  let commission = 0;
  for (const sku of skus) {
    commissionBase += money(sku.actual_commission_base) || money(sku.estimated_commission_base);
    commission += money(sku.actual_paid_commission) || money(sku.estimated_paid_commission);
  }
  return {
    orderId: String(order.id),
    creator: named.creator_username,
    contentType: named.content_type || null,
    commissionBase: Number(commissionBase.toFixed(2)),
    commission: Number(commission.toFixed(2)),
  };
}

/** Walks every page. `maxOrders` is a stop, reported rather than applied silently. */
export async function fetchAffiliateOrders({ accessToken, shopCipher, createTimeGe, createTimeLt, maxOrders = 5000 }) {
  const rows = [];
  let pageToken;
  let error = null;
  let sample = null;
  let truncated = false;
  do {
    const page = await searchAffiliateOrders({ accessToken, shopCipher, createTimeGe, createTimeLt, pageToken });
    if (page.error) { error = page.error; break; }
    for (const order of page.data?.orders || []) {
      if (!sample) sample = order;
      const normalized = normalizeAffiliateOrder(order);
      if (normalized) rows.push(normalized);
    }
    pageToken = page.data?.next_page_token || undefined;
    if (rows.length >= maxOrders) { truncated = Boolean(pageToken); break; }
  } while (pageToken);
  return { rows, error, sample, truncated };
}
