import { createHmac } from "crypto";
import { NextResponse } from "next/server";
import { currentUser, decryptCredentials } from "../../../../lib/auth";
import { database, ensureSchema } from "../../../../lib/db";

export const runtime = "nodejs";

// TikTok Shop signs every Open API call: sort the query params, concatenate
// key+value between the path, and HMAC-SHA256 it with the app secret.
function sign(path, params, secret) {
  const ordered = Object.keys(params).filter(key => key !== "sign" && key !== "access_token").sort();
  const base = path + ordered.map(key => `${key}${params[key]}`).join("");
  return createHmac("sha256", secret).update(secret + base + secret).digest("hex");
}

async function callShopApi(path, accessToken) {
  const appKey = process.env.TIKTOK_APP_KEY;
  const appSecret = process.env.TIKTOK_APP_SECRET;
  if (!appKey || !appSecret) return { error: "TikTok credentials are not configured." };
  const params = { app_key: appKey, timestamp: Math.floor(Date.now() / 1000) };
  params.sign = sign(path, params, appSecret);
  const query = new URLSearchParams(params);
  const response = await fetch(`https://open-api.tiktokglobalshop.com${path}?${query}`, {
    headers: { "content-type": "application/json", "x-tts-access-token": accessToken },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.code !== 0) return { error: payload?.message || `TikTok returned ${response.status}` };
  return { data: payload.data };
}

// Everything the UI shows about the connected shop. Falls back to what the OAuth
// callback stored, so the panel still has something useful if the live call fails
// (expired token, revoked permission, TikTok outage).
export async function GET(request) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    await ensureSchema();
    const q = database();
    const [connection] = await q`SELECT status,external_id,metadata,credentials,updated_at FROM tl_connections WHERE workspace_id=${user.workspace_id} AND provider='tiktok_shop'`;
    if (!connection) return NextResponse.json({ connected: false });

    const metadata = connection.metadata || {};
    const base = {
      connected: connection.status === "connected" || !!connection.credentials,
      status: connection.status,
      openId: connection.external_id || null,
      sellerName: metadata.sellerName || null,
      region: metadata.sellerBaseRegion || null,
      permissions: metadata.grantedPermissions || [],
      connectedAt: metadata.connectedAt || connection.updated_at,
    };
    if (!connection.credentials) return NextResponse.json({ ...base, connected: false });

    let credentials = null;
    try { credentials = decryptCredentials(connection.credentials); } catch { credentials = null; }
    if (!credentials?.accessToken) return NextResponse.json({ ...base, error: "Stored credentials could not be read." });

    const shops = await callShopApi("/authorization/202309/shops", credentials.accessToken);
    if (shops.error) return NextResponse.json({ ...base, shops: [], liveError: shops.error });

    const list = (shops.data?.shops || []).map(shop => ({
      id: shop.id, name: shop.name, region: shop.region, code: shop.code, cipher: shop.cipher, type: shop.seller_type,
    }));
    // Cache the shop name so the panel reads well even when offline.
    if (list[0]?.name && list[0].name !== metadata.sellerName) {
      await q`UPDATE tl_connections SET metadata=metadata || ${JSON.stringify({ sellerName: list[0].name, sellerBaseRegion: list[0].region })}::jsonb WHERE workspace_id=${user.workspace_id} AND provider='tiktok_shop'`;
    }
    return NextResponse.json({ ...base, sellerName: list[0]?.name || base.sellerName, region: list[0]?.region || base.region, shops: list });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Could not load the shop." }, { status: 500 });
  }
}
