import { decryptCredentials, encryptCredentials } from "./auth";
import { database, ensureSchema } from "./db";

/**
 * TikTok Business Center (Marketing API) — a second, separate integration.
 *
 * This is not the TikTok Shop API: different host, different developer app,
 * different OAuth, and the token goes in an `Access-Token` header rather than
 * `x-tts-access-token`. Nothing here shares credentials with the Shop client.
 *
 * Why it exists: ad spend paid by card never appears in Shop settlement, so
 * "Kos Ads By Card" is the last cost a seller has to type by hand. Business
 * Center reports every payment with its method — card vs GMV Pay — which is
 * exactly the split the P&L needs.
 */

const API = "https://business-api.tiktok.com/open_api/v1.3";
const PORTAL = "https://business-api.tiktok.com/portal/auth";

export function businessConfigured() {
  return Boolean(process.env.TIKTOK_BUSINESS_APP_ID && process.env.TIKTOK_BUSINESS_SECRET);
}

/** Where the seller is sent to authorize. `state` is verified on the way back. */
export function authorizeUrl(state, redirectUri) {
  const query = new URLSearchParams({
    app_id: process.env.TIKTOK_BUSINESS_APP_ID || "",
    state,
    redirect_uri: redirectUri,
    rid: state.slice(0, 16),
  });
  return `${PORTAL}?${query}`;
}

async function call(path, { accessToken, query = {}, method = "GET", body }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  const url = `${API}${path}${params.toString() ? `?${params}` : ""}`;
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...(accessToken ? { "Access-Token": accessToken } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const json = await response.json().catch(() => null);
  // The Marketing API always returns HTTP 200; the real status is in `code`.
  if (!json || json.code !== 0) return { error: json?.message || `TikTok Business returned ${response.status}`, code: json?.code ?? response.status };
  return { data: json.data };
}

/** Exchanges the one-time auth code. Marketing API tokens do not expire like Shop's. */
export async function exchangeCode(authCode) {
  const result = await call("/oauth2/access_token/", {
    method: "POST",
    body: { app_id: process.env.TIKTOK_BUSINESS_APP_ID, secret: process.env.TIKTOK_BUSINESS_SECRET, auth_code: authCode, grant_type: "auth_code" },
  });
  if (result.error) return result;
  return { data: { accessToken: result.data?.access_token, scope: result.data?.scope, advertiserIds: result.data?.advertiser_ids || [] } };
}

/** Business Centers this token can see. */
export function listBusinessCenters(accessToken) {
  return call("/bc/get/", { accessToken, query: { page_size: 50 } });
}

/** Transaction records for one Business Center, in a date window. */
export function bcTransactions({ accessToken, bcId, startDate, endDate, page = 1, pageSize = 50 }) {
  return call("/bc/transaction/get/", { accessToken, query: { bc_id: bcId, start_date: startDate, end_date: endDate, page, page_size: pageSize } });
}

/** Transaction records at the ad-account level, which carry the payment method. */
export function advertiserTransactions({ accessToken, bcId, page = 1, pageSize = 50 }) {
  return call("/bc/advertiser/transaction/get/", { accessToken, query: { bc_id: bcId, page, page_size: pageSize } });
}

/**
 * Classifies a transaction by how it was funded.
 *
 * TikTok reports the method inside a free-text description ("Payment method:
 * GMV Pay" / "Credit or debit card"), so this matches on the text and falls back
 * to "other" rather than guessing — an unrecognised method must not be silently
 * counted as card spend, which is the only bucket that gets deducted from profit.
 */
export function paymentMethodOf(transaction) {
  const haystack = [transaction.description, transaction.payment_method, transaction.fund_type, transaction.transaction_type]
    .filter(Boolean).join(" ").toLowerCase();
  if (/gmv\s*pay/.test(haystack)) return "gmv_pay";
  if (/credit|debit|card/.test(haystack)) return "card";
  if (/coupon|credit line|gift/.test(haystack)) return "credit";
  return "other";
}

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function normalizeTransaction(transaction, bcId) {
  const id = transaction.transaction_id || transaction.id || transaction.order_id;
  if (!id) return null;
  const createdRaw = transaction.create_time || transaction.transaction_time || transaction.date;
  const created = createdRaw
    ? (String(createdRaw).match(/^\d+$/) ? new Date(Number(createdRaw) * 1000) : new Date(createdRaw))
    : null;
  return {
    transactionId: String(id),
    bcId: String(bcId),
    advertiserId: transaction.advertiser_id ? String(transaction.advertiser_id) : null,
    advertiserName: transaction.advertiser_name || transaction.account_name || null,
    method: paymentMethodOf(transaction),
    description: transaction.description || null,
    fundType: transaction.fund_type || null,
    status: transaction.status || null,
    amount: num(transaction.amount ?? transaction.cash_amount),
    currency: transaction.currency || "MYR",
    occurredAt: created && !Number.isNaN(created.getTime()) ? created.toISOString() : null,
    raw: transaction,
  };
}

/* ------------------------------------------------------------- connection */

export async function businessAccess(workspaceId) {
  await ensureSchema();
  const q = database();
  const [connection] = await q`SELECT credentials, metadata FROM tl_connections WHERE workspace_id=${workspaceId} AND provider='tiktok_business' LIMIT 1`;
  if (!connection?.credentials) return { ok: false, reason: "not_connected" };
  if (!businessConfigured()) return { ok: false, reason: "not_configured" };
  let credentials = null;
  try { credentials = decryptCredentials(connection.credentials); } catch { credentials = null; }
  if (!credentials?.accessToken) return { ok: false, reason: "unreadable_credentials" };
  const metadata = connection.metadata || {};
  return { ok: true, accessToken: credentials.accessToken, bcId: metadata.bcId, bcName: metadata.bcName };
}

export async function saveBusinessConnection(workspaceId, { accessToken, bcId, bcName, advertiserIds }) {
  await ensureSchema();
  const q = database();
  const metadata = { bcId: bcId || null, bcName: bcName || null, advertiserIds: advertiserIds || [], connectedAt: new Date().toISOString() };
  const [existing] = await q`SELECT id FROM tl_connections WHERE workspace_id=${workspaceId} AND provider='tiktok_business' LIMIT 1`;
  if (existing) {
    await q`UPDATE tl_connections SET status='connected', credentials=${encryptCredentials({ accessToken })}, metadata=${JSON.stringify(metadata)}::jsonb, updated_at=now() WHERE id=${existing.id}`;
    return;
  }
  await q`INSERT INTO tl_connections (id, workspace_id, provider, status, external_id, credentials, metadata)
    VALUES (${`con_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`}, ${workspaceId}, 'tiktok_business', 'connected', ${bcId || null}, ${encryptCredentials({ accessToken })}, ${JSON.stringify(metadata)}::jsonb)`;
}

/** Walks every page of BC transactions in the window. */
export async function fetchAdTransactions({ accessToken, bcId, startDate, endDate, maxRows = 2000 }) {
  const rows = [];
  let page = 1;
  let error = null;
  let sample = null;
  for (;;) {
    const result = await bcTransactions({ accessToken, bcId, startDate, endDate, page, pageSize: 50 });
    if (result.error) { error = result.error; break; }
    const list = result.data?.list || result.data?.transactions || [];
    for (const item of list) {
      if (!sample) sample = item;
      const normalized = normalizeTransaction(item, bcId);
      if (normalized) rows.push(normalized);
    }
    const info = result.data?.page_info;
    if (!list.length || !info || page >= (info.total_page || 1) || rows.length >= maxRows) break;
    page += 1;
  }
  return { rows, error, sample };
}
