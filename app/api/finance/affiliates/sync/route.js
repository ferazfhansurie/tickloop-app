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

  // TikTok reports a missing scope as a generic "Access denied", which does not
  // say what to do about it. The fix is specific and worth stating.
  const scopeDenied = /access denied|access scope|not authorized/i.test(result.error || "");
  const error = scopeDenied
    ? "Your shop authorization does not include affiliate access. In Partner Center enable the Affiliate scopes on the app, then reconnect the shop so a new token picks them up."
    : result.error || null;

  return NextResponse.json({
    scopeDenied,
    imported: result.rows.length,
    creators: new Set(result.rows.map((row) => row.creator)).size,
    windowDays: days,
    truncated: result.truncated,
    error,
    tiktokMessage: result.error || null,
    sample: result.sample || null,
  });
}

export const POST = run;
export const GET = run;
