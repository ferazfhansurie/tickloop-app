import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "../../../../lib/auth";
import { database, ensureSchema } from "../../../../lib/db";

export async function GET(request) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    if (!isAdmin(user)) return NextResponse.json({ error: "Admin access required." }, { status: 403 });
    await ensureSchema();
    const q = database();
    const [totals, users] = await Promise.all([
      q`SELECT
          (SELECT count(*)::int FROM tl_users) AS users,
          (SELECT count(*)::int FROM tl_workspaces) AS workspaces,
          (SELECT count(*)::int FROM tl_connections WHERE provider='tiktok_shop' AND status='connected') AS tiktok_connected,
          (SELECT count(*)::int FROM tl_connections WHERE provider='whatsapp' AND status='connected') AS whatsapp_connected`,
      q`SELECT u.id,u.name,u.email,u.role,u.created_at,w.id AS workspace_id,w.name AS workspace_name,
          COALESCE(max(c.status) FILTER (WHERE c.provider='tiktok_shop'), 'not_connected') AS tiktok_status,
          COALESCE(max(c.status) FILTER (WHERE c.provider='whatsapp'), 'not_connected') AS whatsapp_status
        FROM tl_users u
        LEFT JOIN tl_workspaces w ON w.owner_id=u.id
        LEFT JOIN tl_connections c ON c.workspace_id=w.id
        GROUP BY u.id,w.id
        ORDER BY u.created_at DESC`
    ]);
    return NextResponse.json({ totals: totals[0], users });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Could not load admin data." }, { status: 500 });
  }
}
