import { createHmac, timingSafeEqual } from "crypto";
import { decryptCredentials, encryptCredentials } from "./auth";
import { database, ensureSchema } from "./db";

// Shared TikTok Shop Open API access. The OAuth callback stores
// { accessToken, refreshToken, accessTokenExpiresAt } encrypted on the
// connection row; access tokens last 7 days, so every call goes through
// shopAccess() which refreshes and re-persists on demand rather than letting a
// 401 surface to the UI.

const API_BASE = "https://open-api.tiktokglobalshop.com";
const AUTH_BASE = "https://auth.tiktok-shops.com";

// TikTok signs every call: sort the query params, concatenate key+value after
// the path, append the raw body, and HMAC-SHA256 the whole thing wrapped in the
// app secret. `sign` and `access_token` are themselves excluded.
function sign(path, params, body, secret) {
  const ordered = Object.keys(params)
    .filter((key) => key !== "sign" && key !== "access_token" && params[key] !== undefined && params[key] !== null)
    .sort();
  const base = path + ordered.map((key) => `${key}${params[key]}`).join("") + (body || "");
  return createHmac("sha256", secret).update(secret + base + secret).digest("hex");
}

export function tiktokConfigured() {
  return Boolean(process.env.TIKTOK_APP_KEY && process.env.TIKTOK_APP_SECRET);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** TikTok throttles bursts ("Too many requests for downstream"), which is retryable. */
function isRateLimited(status, message) {
  return status === 429 || /too many requests|rate limit|qps/i.test(message || "");
}

/**
 * One signed Open API call, retrying through TikTok's burst throttle.
 *
 * Walking every payout statement means dozens of calls in a row, which trips the
 * limit reliably. Without backoff the sync stops partway and silently reports a
 * settlement total that is short by whatever it never fetched.
 */
export async function callShop({ path, method = "GET", query = {}, body, accessToken, attempts = 4 }) {
  const appKey = process.env.TIKTOK_APP_KEY;
  const appSecret = process.env.TIKTOK_APP_SECRET;
  if (!appKey || !appSecret) return { error: "TikTok credentials are not configured." };

  const payload = body === undefined ? "" : JSON.stringify(body);
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // The timestamp and therefore the signature must be rebuilt per attempt.
    const params = { app_key: appKey, timestamp: Math.floor(Date.now() / 1000) };
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") params[key] = value;
    }
    params.sign = sign(path, params, payload, appSecret);

    const response = await fetch(`${API_BASE}${path}?${new URLSearchParams(params)}`, {
      method,
      headers: { "content-type": "application/json", "x-tts-access-token": accessToken },
      ...(payload ? { body: payload } : {}),
      cache: "no-store",
    });
    const json = await response.json().catch(() => null);
    if (response.ok && json?.code === 0) return { data: json.data };

    const message = json?.message || `TikTok returned ${response.status}`;
    lastError = { error: message, code: json?.code ?? response.status };
    if (!isRateLimited(response.status, message) || attempt === attempts - 1) return lastError;
    await sleep(700 * 2 ** attempt); // 700ms, 1.4s, 2.8s
  }
  return lastError;
}

export { sleep };

async function refreshToken(refresh) {
  const query = new URLSearchParams({
    app_key: process.env.TIKTOK_APP_KEY || "",
    app_secret: process.env.TIKTOK_APP_SECRET || "",
    grant_type: "refresh_token",
    refresh_token: refresh,
  });
  const response = await fetch(`${AUTH_BASE}/api/v2/token/refresh?${query}`, { headers: { "content-type": "application/json" }, cache: "no-store" });
  const json = await response.json().catch(() => null);
  const token = json?.data;
  if (!response.ok || json?.code !== 0 || !token?.access_token) return null;
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || refresh,
    accessTokenExpiresAt: token.access_token_expire_in,
    refreshTokenExpiresAt: token.refresh_token_expire_in,
  };
}

/**
 * A live access token plus the shop cipher, for one workspace.
 *
 * The cipher is required by every order and finance call but is not part of the
 * OAuth response, so it is fetched once and cached on the connection metadata.
 * Returns { ok: false, reason } rather than throwing — the dashboard renders a
 * specific message for each reason.
 */
export async function shopAccess(workspaceId) {
  await ensureSchema();
  const q = database();
  const [connection] = await q`SELECT id, external_id, metadata, credentials FROM tl_connections WHERE workspace_id=${workspaceId} AND provider='tiktok_shop' LIMIT 1`;
  if (!connection) return { ok: false, reason: "not_connected" };
  if (!connection.credentials) return { ok: false, reason: "not_connected" };
  if (!tiktokConfigured()) return { ok: false, reason: "not_configured" };

  let credentials = null;
  try { credentials = decryptCredentials(connection.credentials); } catch { credentials = null; }
  if (!credentials?.accessToken) return { ok: false, reason: "unreadable_credentials" };

  const metadata = connection.metadata || {};
  let changed = false;

  const expiresAt = Number(credentials.accessTokenExpiresAt || 0);
  if (expiresAt && expiresAt * 1000 - Date.now() < 5 * 60 * 1000) {
    if (!credentials.refreshToken) return { ok: false, reason: "token_expired" };
    const refreshed = await refreshToken(credentials.refreshToken);
    if (!refreshed) return { ok: false, reason: "refresh_failed" };
    credentials = refreshed;
    changed = true;
  }

  let shopCipher = metadata.shopCipher;
  let shopId = metadata.shopId;
  if (!shopCipher) {
    const shops = await callShop({ path: "/authorization/202309/shops", accessToken: credentials.accessToken });
    if (shops.error) return { ok: false, reason: "shop_lookup_failed", detail: shops.error };
    const shop = (shops.data?.shops || [])[0];
    if (!shop?.cipher) return { ok: false, reason: "no_authorized_shop" };
    shopCipher = shop.cipher;
    shopId = shop.id;
    Object.assign(metadata, { shopCipher: shop.cipher, shopId: shop.id, sellerName: shop.name || metadata.sellerName, sellerBaseRegion: shop.region || metadata.sellerBaseRegion });
    changed = true;
  }

  if (changed) {
    await q`UPDATE tl_connections SET credentials=${encryptCredentials(credentials)}, metadata=${JSON.stringify(metadata)}::jsonb, updated_at=now() WHERE id=${connection.id}`;
  }

  return {
    ok: true,
    accessToken: credentials.accessToken,
    shopCipher,
    shopId,
    sellerName: metadata.sellerName || null,
    region: metadata.sellerBaseRegion || null,
    // Recorded at authorization time. Finance calls need the Seller Finance scope,
    // so the dashboard can say "re-authorize" instead of showing a bare API error.
    grantedPermissions: metadata.grantedPermissions || [],
  };
}

export function hasFinanceScope(grantedPermissions) {
  if (!grantedPermissions?.length) return null; // unknown — TikTok did not report scopes
  return grantedPermissions.some((permission) => /finance/i.test(String(permission)));
}

/* --------------------------------------------------------------------- orders */

export const ORDER_STATUSES = ["UNPAID", "ON_HOLD", "AWAITING_SHIPMENT", "PARTIALLY_SHIPPING", "AWAITING_COLLECTION", "IN_TRANSIT", "DELIVERED", "COMPLETED", "CANCELLED"];

/** One page of orders created in the window. */
export async function searchOrders({ accessToken, shopCipher, status, createTimeGe, createTimeLt, pageToken, pageSize = 50 }) {
  const body = {};
  if (status) body.order_status = status;
  if (createTimeGe) body.create_time_ge = createTimeGe;
  if (createTimeLt) body.create_time_lt = createTimeLt;
  return callShop({
    path: "/order/202309/orders/search",
    method: "POST",
    query: { shop_cipher: shopCipher, page_size: pageSize, page_token: pageToken, sort_field: "create_time" },
    body,
    accessToken,
  });
}

/** Walks every page. `maxOrders` is a safety stop and is reported, not silent. */
export async function searchAllOrders(input, maxOrders = 2000) {
  const orders = [];
  let pageToken;
  let truncated = false;
  do {
    const page = await searchOrders({ ...input, pageToken });
    if (page.error) return { error: page.error, orders };
    for (const order of page.data?.orders || []) orders.push(order);
    pageToken = page.data?.next_page_token || undefined;
    if (orders.length >= maxOrders) { truncated = Boolean(pageToken); break; }
  } while (pageToken);
  return { orders, truncated };
}

const epochToIso = (seconds) => {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
};

export function normalizeOrder(order) {
  const items = (order.line_items || []).map((item) => ({
    productId: item.product_id || null,
    productName: item.product_name || null,
    skuId: item.sku_id || null,
    skuName: item.sku_name || null,
    sellerSku: item.seller_sku || null,
    salePrice: item.sale_price || null,
    // The 202309 payload emits one line_item per unit, so a missing quantity
    // means exactly one unit — not an unknown amount.
    quantity: Number(item.quantity ?? 1) || 1,
  }));
  return {
    orderId: order.id,
    status: String(order.status || "").toUpperCase(),
    currency: order.payment?.currency || null,
    totalAmount: order.payment?.total_amount ?? null,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    createTime: epochToIso(order.create_time),
    paidTime: epochToIso(order.paid_time),
    updateTime: epochToIso(order.update_time),
    items,
    raw: order,
  };
}

/** Full detail for specific orders — used to hydrate a single order from a webhook. */
export async function getOrderDetail({ accessToken, shopCipher, ids }) {
  return callShop({ path: "/order/202309/orders", accessToken, query: { shop_cipher: shopCipher, ids: ids.join(",") } });
}

/**
 * Verifies a TikTok Shop webhook.
 *
 * The signature is HMAC-SHA256 of (app_key + raw body) keyed with the app secret,
 * delivered in the Authorization header — not a hash of the body alone, and not
 * the `Tiktok-Signature` scheme used by the non-Shop developer webhooks.
 */
export function verifyWebhook(rawBody, signature) {
  const appKey = process.env.TIKTOK_APP_KEY;
  const appSecret = process.env.TIKTOK_APP_SECRET;
  if (!appKey || !appSecret || !signature) return false;
  const expected = createHmac("sha256", appSecret).update(appKey + rawBody).digest("hex");
  const received = Buffer.from(String(signature));
  const digest = Buffer.from(expected);
  return received.length === digest.length && timingSafeEqual(received, digest);
}

/** Workspace that owns a TikTok shop id, for routing inbound webhooks. */
export async function workspaceForShop(shopId) {
  await ensureSchema();
  const rows = await database()`SELECT workspace_id FROM tl_connections WHERE provider='tiktok_shop' AND (metadata->>'shopId' = ${shopId} OR external_id = ${shopId}) LIMIT 1`;
  return rows[0]?.workspace_id;
}
