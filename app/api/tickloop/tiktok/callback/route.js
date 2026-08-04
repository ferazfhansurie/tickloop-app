import { NextResponse } from "next/server";
import { encryptCredentials } from "../../../../../lib/auth";
import { database, ensureSchema } from "../../../../../lib/db";

export const runtime = "nodejs";

function redirect(request, result) {
  return NextResponse.redirect(new URL(`/?tiktok=${result}`, request.url));
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const state = searchParams.get("state");
  const authorizationCode = searchParams.get("code") || searchParams.get("auth_code");
  if (!state || !authorizationCode) return redirect(request, "cancelled");

  try {
    await ensureSchema();
    const q = database();
    const rows = await q`SELECT id, workspace_id FROM tl_connections WHERE provider = 'tiktok_shop' AND status = 'authorizing' AND metadata->>'state' = ${state} LIMIT 1`;
    const connection = rows[0];
    if (!connection) return redirect(request, "invalid_state");

    const query = new URLSearchParams({
      app_key: process.env.TIKTOK_APP_KEY || "",
      app_secret: process.env.TIKTOK_APP_SECRET || "",
      grant_type: "authorized_code",
      auth_code: authorizationCode,
    });
    if (!process.env.TIKTOK_APP_KEY || !process.env.TIKTOK_APP_SECRET) return redirect(request, "not_configured");
    const response = await fetch(`https://auth.tiktok-shops.com/api/v2/token/get?${query}`, { headers: { "content-type": "application/json" }, cache: "no-store" });
    const payload = await response.json();
    const token = payload?.data;
    if (!response.ok || payload?.code !== 0 || !token?.access_token) return redirect(request, "token_error");

    const metadata = { sellerName: token.seller_name || null, sellerBaseRegion: token.seller_base_region || null, grantedPermissions: token.granted_permissions || [] };
    const credentials = encryptCredentials({ accessToken: token.access_token, refreshToken: token.refresh_token, accessTokenExpiresAt: token.access_token_expire_in, refreshTokenExpiresAt: token.refresh_token_expire_in });
    await q`UPDATE tl_connections SET status = 'connected', external_id = ${token.open_id || null}, metadata = ${JSON.stringify(metadata)}::jsonb, credentials = ${credentials}, updated_at = now() WHERE id = ${connection.id}`;
    return redirect(request, "connected");
  } catch {
    return redirect(request, "error");
  }
}
