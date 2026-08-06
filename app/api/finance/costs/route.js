import { NextResponse } from "next/server";
import { currentUser } from "../../../../lib/auth";
import { deleteProductCost, listPeriodCosts, listProductCosts, savePeriodCost, saveProductCosts } from "../../../../lib/finance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const [products, periods] = await Promise.all([listProductCosts(user.workspace_id), listPeriodCosts(user.workspace_id)]);
  return NextResponse.json({ products, periods });
}

/**
 * POST /api/finance/costs
 *   { products: [{ skuKey, bundle, unitCost, bottles, sortOrder }] }
 *   { period: { period: "2026-08", adsCard, adCredit, whtRate, otherCost, adsGmvPayOverride, notes } }
 *   { deleteSkuKey: "..." }
 */
export async function POST(request) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    const payload = await request.json().catch(() => ({}));

    if (Array.isArray(payload.products)) {
      const products = payload.products
        .filter((product) => product?.skuKey)
        .map((product, index) => ({
          skuKey: String(product.skuKey),
          bundle: String(product.bundle || product.skuKey),
          unitCost: Number(product.unitCost) || 0,
          bottles: Number(product.bottles) || 0,
          sortOrder: Number.isFinite(Number(product.sortOrder)) ? Number(product.sortOrder) : index,
        }));
      if (products.length) await saveProductCosts(user.workspace_id, products);
    }

    if (payload.period?.period) {
      const override = payload.period.adsGmvPayOverride;
      await savePeriodCost(user.workspace_id, {
        period: String(payload.period.period),
        adsCard: Number(payload.period.adsCard) || 0,
        adCredit: Number(payload.period.adCredit) || 0,
        whtRate: Number.isFinite(Number(payload.period.whtRate)) ? Number(payload.period.whtRate) : 0.1,
        otherCost: Number(payload.period.otherCost) || 0,
        // null means "trust the synced GMV Max ad fee" — distinct from an override of 0.
        adsGmvPayOverride: override === null || override === undefined || override === "" ? null : Number(override) || 0,
        notes: payload.period.notes ?? null,
      });
    }

    if (payload.deleteSkuKey) await deleteProductCost(user.workspace_id, String(payload.deleteSkuKey));

    const [products, periods] = await Promise.all([listProductCosts(user.workspace_id), listPeriodCosts(user.workspace_id)]);
    return NextResponse.json({ products, periods });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Could not save." }, { status: 500 });
  }
}
