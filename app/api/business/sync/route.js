import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";
import { saveAdTransactions } from "../../../../lib/finance";
import { businessAccess, fetchAdTransactions } from "../../../../lib/tiktok-business";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const isoDate = (date) => date.toISOString().slice(0, 10);

/** POST to sync; GET returns the same payload plus a sample row, for debugging. */
async function run(request) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const access = await businessAccess(user.workspace_id);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: 409 });
  if (!access.bcId) return NextResponse.json({ error: "no_business_center" }, { status: 409 });

  const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get("days")) || 180, 1), 365);
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);

  const result = await fetchAdTransactions({
    accessToken: access.accessToken,
    bcId: access.bcId,
    startDate: isoDate(start),
    endDate: isoDate(end),
  });
  if (result.rows.length) await saveAdTransactions(user.workspace_id, result.rows);

  const byMethod = result.rows.reduce((acc, row) => {
    acc[row.method] = Number(((acc[row.method] || 0) + Math.abs(row.amount)).toFixed(2));
    return acc;
  }, {});

  return NextResponse.json({
    businessCenter: access.bcName || access.bcId,
    windowDays: days,
    saved: result.rows.length,
    byMethod,
    error: result.error || null,
    // The payment method lives in a free-text description, so surface one raw row:
    // if the classifier ever mislabels card spend, this is how it gets caught.
    sample: result.sample || null,
  });
}

export const POST = run;
export const GET = run;
