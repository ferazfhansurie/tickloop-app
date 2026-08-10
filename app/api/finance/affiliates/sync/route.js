import { NextResponse } from "next/server";
import { currentUser } from "../../../../../lib/auth";
import { saveAttributions } from "../../../../../lib/finance";
import { shopAccess } from "../../../../../lib/tiktok";
import { fetchAffiliateOrders } from "../../../../../lib/tiktok-affiliate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Pulls creator attribution straight from TikTok, replacing the CSV upload.
 *
 * Needs the affiliate scope on the shop authorization; if it is missing the API
 * says so and that message is passed through rather than reduced to "failed",
 * because the fix (reconnect and approve) depends on knowing which it was.
 */
async function run(request) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const access = await shopAccess(user.workspace_id);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: 409 });

  const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get("days")) || 90, 1), 365);
  const result = await fetchAffiliateOrders({
    accessToken: access.accessToken,
    shopCipher: access.shopCipher,
    createTimeGe: Math.floor(Date.now() / 1000) - days * 86400,
  });

  if (result.rows.length) await saveAttributions(user.workspace_id, result.rows);

  return NextResponse.json({
    imported: result.rows.length,
    creators: new Set(result.rows.map((row) => row.creator)).size,
    windowDays: days,
    truncated: result.truncated,
    error: result.error || null,
    sample: result.sample || null,
  });
}

export const POST = run;
export const GET = run;
