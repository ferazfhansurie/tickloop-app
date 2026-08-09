import { NextResponse } from "next/server";
import { database, ensureSchema } from "../../../../lib/db";
import { exchangeCode, listBusinessCenters, saveBusinessConnection } from "../../../../lib/tiktok-business";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const back = (request, result) => NextResponse.redirect(new URL(`/?business=${result}`, request.url));

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const state = searchParams.get("state");
  const authCode = searchParams.get("auth_code") || searchParams.get("code");
  if (!state || !authCode) return back(request, "cancelled");

  try {
    await ensureSchema();
    const q = database();
    const [connection] = await q`SELECT workspace_id FROM tl_connections WHERE provider='tiktok_business' AND metadata->>'state' = ${state} LIMIT 1`;
    if (!connection) return back(request, "invalid_state");

    const token = await exchangeCode(authCode);
    if (token.error) return back(request, `token_error&reason=${encodeURIComponent(String(token.error).slice(0, 120))}`);

    // Pick up the Business Center id now, so the sync has something to query.
    const centers = await listBusinessCenters(token.data.accessToken);
    const first = (centers.data?.list || [])[0];
    const bc = first?.bc_info || first;

    await saveBusinessConnection(connection.workspace_id, {
      accessToken: token.data.accessToken,
      bcId: bc?.bc_id || null,
      bcName: bc?.name || null,
      advertiserIds: token.data.advertiserIds,
    });
    return back(request, "connected");
  } catch (error) {
    return back(request, `error&reason=${encodeURIComponent(String(error?.message || "unknown").slice(0, 120))}`);
  }
}
