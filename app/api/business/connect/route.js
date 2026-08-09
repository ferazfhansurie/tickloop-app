import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";
import { database, ensureSchema } from "../../../../lib/db";
import { authorizeUrl, businessConfigured } from "../../../../lib/tiktok-business";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts the Business Center authorization. */
export async function GET(request) {
  const user = await currentUser(request);
  if (!user) return NextResponse.redirect(new URL("/?business=signin", request.url));
  if (!businessConfigured()) return NextResponse.redirect(new URL("/?business=not_configured", request.url));

  await ensureSchema();
  const q = database();
  const state = randomBytes(24).toString("base64url");
  // The state is parked on a pending connection row, mirroring how the Shop
  // callback verifies its own state — no extra table needed.
  const [existing] = await q`SELECT id FROM tl_connections WHERE workspace_id=${user.workspace_id} AND provider='tiktok_business' LIMIT 1`;
  if (existing) await q`UPDATE tl_connections SET status='authorizing', metadata = metadata || ${JSON.stringify({ state })}::jsonb, updated_at=now() WHERE id=${existing.id}`;
  else await q`INSERT INTO tl_connections (id, workspace_id, provider, status, metadata) VALUES (${`con_${randomBytes(10).toString("hex")}`}, ${user.workspace_id}, 'tiktok_business', 'authorizing', ${JSON.stringify({ state })}::jsonb)`;

  const redirectUri = `${new URL(request.url).origin}/api/business/callback`;
  return NextResponse.redirect(authorizeUrl(state, redirectUri));
}
