import { NextResponse } from "next/server";
import { buildAttributions, detectColumns, parseCsv } from "../../../../lib/affiliate";
import { currentUser } from "../../../../lib/auth";
import { database, ensureSchema } from "../../../../lib/db";
import { saveAttributions } from "../../../../lib/finance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/finance/affiliates — body is the raw CSV text of the Affiliate export.
 *
 * Reports how many rows matched an order we already hold. A low match rate almost
 * always means the wrong column was picked up, so the detected mapping and a
 * sample of unmatched ids come back with the result rather than failing silently.
 */
export async function POST(request) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

    const text = await request.text();
    if (!text.trim()) return NextResponse.json({ error: "Empty file." }, { status: 400 });
    // .xlsx is a zip, so it starts with PK — catch it here rather than parsing binary as CSV.
    if (/^PK/.test(text)) {
      return NextResponse.json({ error: "That looks like an .xlsx file. Open it and Save As CSV, then upload again." }, { status: 400 });
    }

    const { headers, rows } = parseCsv(text);
    if (!headers.length) return NextResponse.json({ error: "Could not read any rows." }, { status: 400 });

    const columns = detectColumns(headers);
    const { attributions, skipped } = buildAttributions(headers, rows, columns);
    if (!attributions.length) {
      return NextResponse.json({ error: "No rows had both an order id and a creator.", headers, columns }, { status: 400 });
    }

    await saveAttributions(user.workspace_id, attributions);

    await ensureSchema();
    const ids = attributions.map((row) => row.orderId);
    const matched = await database()`SELECT count(*) AS n FROM tl_shop_orders WHERE workspace_id=${user.workspace_id} AND order_id = ANY(${ids})`;
    const matchedCount = Number(matched[0]?.n) || 0;

    return NextResponse.json({
      imported: attributions.length,
      skippedRows: skipped,
      matchedOrders: matchedCount,
      unmatchedOrders: attributions.length - matchedCount,
      creators: new Set(attributions.map((row) => row.creator)).size,
      mapping: Object.fromEntries(
        Object.entries(columns).map(([key, index]) => [key, index >= 0 ? headers[index] || `column ${index}` : "(not found)"]),
      ),
      sampleUnmatched: matchedCount === attributions.length ? [] : ids.slice(0, 3),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Import failed." }, { status: 500 });
  }
}
