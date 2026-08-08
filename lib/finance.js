import { database, ensureSchema } from "./db";
import { lineLabel } from "./tiktok-finance";

/**
 * The financial dashboard.
 *
 *   TikTok Orders API   -> Total Sales, per-bundle quantities
 *   TikTok Finance API  -> settlement, and every fee/tax/shipping line behind it,
 *                          including GMV Max ad spend
 *   Seller-entered      -> product cost per SKU, card-billed ad spend, WHT rate
 *
 * Only two things stay manual, and both are genuinely outside TikTok Shop: what a
 * bundle costs to make, and ad spend billed to a card in TikTok Ads Manager (a
 * different API surface with its own OAuth app).
 *
 * Note tl_shop_orders is deliberately separate from the existing tl_orders, which
 * holds the demo/test order used by the automations panel and has an unrelated shape.
 */

let financeReady;
export async function ensureFinanceSchema() {
  if (financeReady) return financeReady;
  financeReady = (async () => {
    await ensureSchema();
    const q = database();
    await q`CREATE TABLE IF NOT EXISTS tl_shop_orders (
      workspace_id text NOT NULL REFERENCES tl_workspaces(id) ON DELETE CASCADE,
      order_id text NOT NULL,
      status text NOT NULL,
      currency text,
      total_amount numeric,
      item_count integer NOT NULL DEFAULT 0,
      create_time timestamptz,
      paid_time timestamptz,
      update_time timestamptz,
      items jsonb NOT NULL DEFAULT '[]'::jsonb,
      synced_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, order_id)
    )`;
    await q`CREATE INDEX IF NOT EXISTS tl_shop_orders_time_idx ON tl_shop_orders (workspace_id, create_time DESC)`;

    await q`CREATE TABLE IF NOT EXISTS tl_settlements (
      workspace_id text NOT NULL REFERENCES tl_workspaces(id) ON DELETE CASCADE,
      transaction_id text NOT NULL,
      order_id text NOT NULL,
      transaction_type text,
      currency text,
      settlement_amount numeric NOT NULL DEFAULT 0,
      revenue_amount numeric NOT NULL DEFAULT 0,
      fee_tax_amount numeric NOT NULL DEFAULT 0,
      shipping_cost_amount numeric NOT NULL DEFAULT 0,
      adjustment_amount numeric NOT NULL DEFAULT 0,
      reserve_amount numeric NOT NULL DEFAULT 0,
      customer_payment_amount numeric NOT NULL DEFAULT 0,
      ad_fee_amount numeric NOT NULL DEFAULT 0,
      breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
      statement_id text,
      statement_time timestamptz,
      order_create_time timestamptz,
      synced_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, transaction_id)
    )`;
    await q`CREATE INDEX IF NOT EXISTS tl_settlements_order_idx ON tl_settlements (workspace_id, order_id)`;

    // One row per sellable SKU: which bundle it belongs to, what it costs us, and
    // how many bottles it contains (trial sachets contain zero — that is Unit ME).
    await q`CREATE TABLE IF NOT EXISTS tl_product_costs (
      workspace_id text NOT NULL REFERENCES tl_workspaces(id) ON DELETE CASCADE,
      sku_key text NOT NULL,
      bundle text NOT NULL,
      unit_cost numeric NOT NULL DEFAULT 0,
      bottles numeric NOT NULL DEFAULT 0,
      sort_order integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, sku_key)
    )`;

    // Every inbound webhook attempt, verified or not. Without this, a signature
    // mismatch is invisible: TikTok reports the failure in Partner Center, not here,
    // and the dashboard just looks like it stopped updating.
    await q`CREATE TABLE IF NOT EXISTS tl_webhook_log (
      id bigserial PRIMARY KEY,
      received_at timestamptz NOT NULL DEFAULT now(),
      event_type text,
      shop_id text,
      order_id text,
      verified boolean NOT NULL DEFAULT false,
      outcome text,
      note text
    )`;
    await q`CREATE INDEX IF NOT EXISTS tl_webhook_log_time_idx ON tl_webhook_log (received_at DESC)`;

    // Month-scoped costs TikTok Shop genuinely cannot tell us.
    await q`CREATE TABLE IF NOT EXISTS tl_period_costs (
      workspace_id text NOT NULL REFERENCES tl_workspaces(id) ON DELETE CASCADE,
      period text NOT NULL,
      ads_card numeric NOT NULL DEFAULT 0,
      ad_credit numeric NOT NULL DEFAULT 0,
      wht_rate numeric NOT NULL DEFAULT 0.10,
      other_cost numeric NOT NULL DEFAULT 0,
      ads_gmv_pay_override numeric,
      notes text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, period)
    )`;
  })();
  return financeReady;
}

/* ------------------------------------------------------------------- writing */

// Neon runs over HTTP, so every statement is a network round trip. A shop with
// 1400 orders needs multi-row inserts, not a loop — one row at a time exhausted
// the function's time limit before the settlement sync was ever reached.
const BATCH = 250;

function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

/** Builds "($1,$2,...),($8,$9,...)" for `columns` values per row. */
function placeholders(rowCount, columns, cast = {}) {
  const rows = [];
  for (let row = 0; row < rowCount; row += 1) {
    const slots = [];
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column + 1;
      slots.push(cast[column] ? `$${index}${cast[column]}` : `$${index}`);
    }
    rows.push(`(${slots.join(",")})`);
  }
  return rows.join(",");
}

export async function saveOrders(workspaceId, orders) {
  await ensureFinanceSchema();
  const q = database();
  for (const batch of chunk(orders, BATCH)) {
    const params = [];
    for (const order of batch) {
      params.push(workspaceId, order.orderId, order.status, order.currency, order.totalAmount, order.itemCount, order.createTime, order.paidTime, order.updateTime, JSON.stringify(order.items));
    }
    await q.query(
      `INSERT INTO tl_shop_orders (workspace_id, order_id, status, currency, total_amount, item_count, create_time, paid_time, update_time, items)
       VALUES ${placeholders(batch.length, 10, { 9: "::jsonb" })}
       ON CONFLICT (workspace_id, order_id) DO UPDATE SET status=EXCLUDED.status, currency=EXCLUDED.currency, total_amount=EXCLUDED.total_amount, item_count=EXCLUDED.item_count, paid_time=EXCLUDED.paid_time, update_time=EXCLUDED.update_time, items=EXCLUDED.items, synced_at=now()`,
      params,
    );
  }
  return orders.length;
}

export async function saveSettlements(workspaceId, rows) {
  await ensureFinanceSchema();
  const q = database();
  for (const batch of chunk(rows, BATCH)) {
    const params = [];
    for (const row of batch) {
      params.push(workspaceId, row.transactionId, row.orderId, row.type, row.currency, row.settlementAmount, row.revenueAmount, row.feeTaxAmount, row.shippingCostAmount, row.adjustmentAmount, row.reserveAmount, row.customerPaymentAmount, row.adFeeAmount, JSON.stringify(row.breakdown), row.statementId, row.statementTime, row.orderCreateTime);
    }
    await q.query(
      `INSERT INTO tl_settlements (workspace_id, transaction_id, order_id, transaction_type, currency, settlement_amount, revenue_amount, fee_tax_amount, shipping_cost_amount, adjustment_amount, reserve_amount, customer_payment_amount, ad_fee_amount, breakdown, statement_id, statement_time, order_create_time)
       VALUES ${placeholders(batch.length, 17, { 13: "::jsonb" })}
       ON CONFLICT (workspace_id, transaction_id) DO UPDATE SET order_id=EXCLUDED.order_id, transaction_type=EXCLUDED.transaction_type, currency=EXCLUDED.currency, settlement_amount=EXCLUDED.settlement_amount, revenue_amount=EXCLUDED.revenue_amount, fee_tax_amount=EXCLUDED.fee_tax_amount, shipping_cost_amount=EXCLUDED.shipping_cost_amount, adjustment_amount=EXCLUDED.adjustment_amount, reserve_amount=EXCLUDED.reserve_amount, customer_payment_amount=EXCLUDED.customer_payment_amount, ad_fee_amount=EXCLUDED.ad_fee_amount, breakdown=EXCLUDED.breakdown, statement_id=EXCLUDED.statement_id, statement_time=EXCLUDED.statement_time, order_create_time=EXCLUDED.order_create_time, synced_at=now()`,
      params,
    );
  }
  return rows.length;
}

/* --------------------------------------------------------------- cost config */

export async function listProductCosts(workspaceId) {
  await ensureFinanceSchema();
  const rows = await database()`SELECT sku_key, bundle, unit_cost, bottles, sort_order FROM tl_product_costs WHERE workspace_id=${workspaceId} ORDER BY sort_order, bundle`;
  return rows.map((row) => ({ skuKey: row.sku_key, bundle: row.bundle, unitCost: Number(row.unit_cost), bottles: Number(row.bottles), sortOrder: Number(row.sort_order) }));
}

export async function saveProductCosts(workspaceId, costs) {
  await ensureFinanceSchema();
  const q = database();
  for (const cost of costs) {
    await q`INSERT INTO tl_product_costs (workspace_id, sku_key, bundle, unit_cost, bottles, sort_order, updated_at)
      VALUES (${workspaceId},${cost.skuKey},${cost.bundle},${cost.unitCost},${cost.bottles},${cost.sortOrder}, now())
      ON CONFLICT (workspace_id, sku_key) DO UPDATE SET bundle=EXCLUDED.bundle, unit_cost=EXCLUDED.unit_cost, bottles=EXCLUDED.bottles, sort_order=EXCLUDED.sort_order, updated_at=now()`;
  }
}

export async function deleteProductCost(workspaceId, skuKey) {
  await ensureFinanceSchema();
  await database()`DELETE FROM tl_product_costs WHERE workspace_id=${workspaceId} AND sku_key=${skuKey}`;
}

const DEFAULT_WHT_RATE = 0.1;

const toPeriodCost = (row) => ({
  period: row.period,
  adsCard: Number(row.ads_card),
  adCredit: Number(row.ad_credit),
  whtRate: Number(row.wht_rate),
  otherCost: Number(row.other_cost),
  adsGmvPayOverride: row.ads_gmv_pay_override === null || row.ads_gmv_pay_override === undefined ? null : Number(row.ads_gmv_pay_override),
  notes: row.notes || null,
});

export async function listPeriodCosts(workspaceId) {
  await ensureFinanceSchema();
  const rows = await database()`SELECT period, ads_card, ad_credit, wht_rate, other_cost, ads_gmv_pay_override, notes FROM tl_period_costs WHERE workspace_id=${workspaceId} ORDER BY period DESC`;
  return rows.map(toPeriodCost);
}

export async function savePeriodCost(workspaceId, cost) {
  await ensureFinanceSchema();
  await database()`INSERT INTO tl_period_costs (workspace_id, period, ads_card, ad_credit, wht_rate, other_cost, ads_gmv_pay_override, notes, updated_at)
    VALUES (${workspaceId},${cost.period},${cost.adsCard},${cost.adCredit},${cost.whtRate},${cost.otherCost},${cost.adsGmvPayOverride},${cost.notes}, now())
    ON CONFLICT (workspace_id, period) DO UPDATE SET ads_card=EXCLUDED.ads_card, ad_credit=EXCLUDED.ad_credit, wht_rate=EXCLUDED.wht_rate, other_cost=EXCLUDED.other_cost, ads_gmv_pay_override=EXCLUDED.ads_gmv_pay_override, notes=EXCLUDED.notes, updated_at=now()`;
}

/* ------------------------------------------------------------------ the P&L */

/** Statuses that represent a sale we recognise. CANCELLED never counts. */
const REVENUE_STATUSES = ["AWAITING_SHIPMENT", "AWAITING_COLLECTION", "PARTIALLY_SHIPPING", "IN_TRANSIT", "DELIVERED", "COMPLETED"];

const skuKeyFor = (item) => String(item.sellerSku || item.skuId || item.skuName || item.productName || "unknown").trim();

function monthsBetween(from, to) {
  const months = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  // `to` is exclusive: a range of Aug 1 -> Sep 1 is August only. Stepping back a
  // millisecond keeps September's manual ad spend out of August's P&L.
  const last = new Date(to.getTime() - 1);
  const end = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1));
  while (cursor <= end) {
    months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

/**
 * Builds the dashboard for a date range.
 *
 *   Kos Produk  = SUM(quantity x unit cost)
 *   Unit ME     = SUM(quantity x bottles)
 *   WHT         = rate x (ads by card + ads by GMV pay)
 *   Nett Profit = Duit Masuk - Kos Produk - Ads By Card - WHT - Other
 *   Profit %    = Nett Profit / Total Sales
 *
 * Ads By GMV Pay is deliberately NOT subtracted again: TikTok charges it as a fee
 * inside the settlement, so it is already absent from Duit Masuk. Subtracting it
 * here would double-count it. It still drives WHT, which the seller pays separately.
 */
export async function financeSummary(workspaceId, fromIso, toIso) {
  await ensureFinanceSchema();
  const q = database();

  const orders = await q`SELECT order_id, status, currency, total_amount, items FROM tl_shop_orders
    WHERE workspace_id=${workspaceId} AND create_time >= ${fromIso} AND create_time < ${toIso}`;

  const counted = orders.filter((order) => REVENUE_STATUSES.includes(String(order.status).toUpperCase()));
  const orderIds = counted.map((order) => order.order_id);

  const settlements = orderIds.length
    ? await q`SELECT order_id, settlement_amount, revenue_amount, fee_tax_amount, shipping_cost_amount, adjustment_amount, reserve_amount, customer_payment_amount, ad_fee_amount, breakdown, currency
        FROM tl_settlements WHERE workspace_id=${workspaceId} AND order_id = ANY(${orderIds})`
    : [];

  const costs = await listProductCosts(workspaceId);
  const costBySku = new Map(costs.map((cost) => [cost.skuKey, cost]));

  // Which orders TikTok has actually paid out on. Duit Masuk only covers these,
  // so the costs netted against it must cover exactly the same orders — otherwise
  // a month mid-payout shows income from the settled few minus the cost of all.
  const settledIds = new Set(settlements.map((row) => row.order_id));

  const quantityBySku = new Map();
  const quantityBySkuSettled = new Map();
  let totalSales = 0;
  let settledSales = 0;
  let currency = "MYR";

  for (const order of counted) {
    const amount = Number(order.total_amount) || 0;
    totalSales += amount;
    const isSettled = settledIds.has(order.order_id);
    if (isSettled) settledSales += amount;
    if (order.currency) currency = order.currency;
    for (const item of order.items || []) {
      const quantity = Number(item.quantity ?? 1) || 1;
      const key = skuKeyFor(item);
      quantityBySku.set(key, (quantityBySku.get(key) || 0) + quantity);
      if (isSettled) quantityBySkuSettled.set(key, (quantityBySkuSettled.get(key) || 0) + quantity);
    }
  }

  /* ---- bundles, product cost, Unit ME ---- */
  const unmappedSkus = [];
  const byBundle = new Map();
  let kosProduk = 0;
  let totalQuantity = 0;
  let unitMe = 0;

  for (const [skuKey, quantity] of quantityBySku) {
    totalQuantity += quantity;
    const cost = costBySku.get(skuKey);
    if (!cost) {
      unmappedSkus.push({ skuKey, quantity });
      const line = byBundle.get(skuKey) || { skuKey, bundle: skuKey, quantity: 0, unitCost: 0, bottles: 0, totalCost: 0, matched: false };
      line.quantity += quantity;
      byBundle.set(skuKey, line);
      continue;
    }
    kosProduk += quantity * cost.unitCost;
    unitMe += quantity * cost.bottles;
    const line = byBundle.get(cost.bundle) || { skuKey: cost.skuKey, bundle: cost.bundle, quantity: 0, unitCost: cost.unitCost, bottles: cost.bottles, totalCost: 0, matched: true };
    line.quantity += quantity;
    line.totalCost += quantity * cost.unitCost;
    byBundle.set(cost.bundle, line);
  }
  const bundleOrder = new Map(costs.map((cost) => [cost.bundle, cost.sortOrder]));
  const bundles = [...byBundle.values()].sort((a, b) => (bundleOrder.get(a.bundle) ?? 999) - (bundleOrder.get(b.bundle) ?? 999));

  // Product cost for the settled cohort only — this is what nets against Duit Masuk.
  let kosProdukSettled = 0;
  for (const [skuKey, quantity] of quantityBySkuSettled) {
    const cost = costBySku.get(skuKey);
    if (cost) kosProdukSettled += quantity * cost.unitCost;
  }

  /* ---- settlement and its breakdown ---- */
  const totals = { settlement: 0, revenue: 0, feeTax: 0, shipping: 0, adjustment: 0, reserve: 0, customerPayment: 0, adFee: 0 };
  const lineTotals = new Map();
  const settledOrderIds = new Set();

  for (const row of settlements) {
    settledOrderIds.add(row.order_id);
    totals.settlement += Number(row.settlement_amount) || 0;
    totals.revenue += Number(row.revenue_amount) || 0;
    totals.feeTax += Number(row.fee_tax_amount) || 0;
    totals.shipping += Number(row.shipping_cost_amount) || 0;
    totals.adjustment += Number(row.adjustment_amount) || 0;
    totals.reserve += Number(row.reserve_amount) || 0;
    totals.customerPayment += Number(row.customer_payment_amount) || 0;
    totals.adFee += Number(row.ad_fee_amount) || 0;
    if (row.currency) currency = row.currency;

    for (const line of row.breakdown || []) {
      const id = `${line.group}:${line.key}`;
      const existing = lineTotals.get(id);
      if (existing) existing.amount += line.amount;
      else lineTotals.set(id, { key: line.key, label: lineLabel(line.key), group: line.group, amount: line.amount });
    }
  }

  const groupRank = { revenue: 0, fee: 1, tax: 2, shipping: 3, adjustment: 4 };
  const lines = [...lineTotals.values()].sort((a, b) => groupRank[a.group] - groupRank[b.group] || Math.abs(b.amount) - Math.abs(a.amount));

  // Each group's lines must add up to the total TikTok reports for that group.
  // A mismatch means a line is double-counted or missing — the failure mode that
  // once displayed shipping as +1770.40 when the real cost was -31.80. Surfaced
  // per group so a restated key cannot quietly corrupt a subtotal again.
  const groupSum = (group) => lines.filter((line) => line.group === group).reduce((total, line) => total + line.amount, 0);
  const lineDrift = [
    { group: "revenue", drift: groupSum("revenue") - totals.revenue },
    { group: "fee+tax", drift: groupSum("fee") + groupSum("tax") - totals.feeTax },
    { group: "shipping", drift: groupSum("shipping") - totals.shipping },
  ].filter((entry) => Math.abs(entry.drift) > 0.05);

  /* ---- manual costs ---- */
  const periods = monthsBetween(new Date(fromIso), new Date(toIso));
  const periodRows = periods.length
    ? await q`SELECT period, ads_card, ad_credit, wht_rate, other_cost, ads_gmv_pay_override, notes FROM tl_period_costs WHERE workspace_id=${workspaceId} AND period = ANY(${periods})`
    : [];
  const periodCosts = periodRows.map(toPeriodCost);

  const adsCard = periodCosts.reduce((sum, cost) => sum + cost.adsCard, 0);
  const adCredit = periodCosts.reduce((sum, cost) => sum + cost.adCredit, 0);
  const otherCost = periodCosts.reduce((sum, cost) => sum + cost.otherCost, 0);
  const whtRate = periodCosts.length ? periodCosts[0].whtRate : DEFAULT_WHT_RATE;

  // GMV Pay is synced from TikTok's ad fees. An override exists because a seller
  // reconciling against an invoice must be able to win an argument with the API.
  const overrides = periodCosts.filter((cost) => cost.adsGmvPayOverride !== null);
  const adsGmvPayIsOverride = overrides.length > 0;
  const adsGmvPay = adsGmvPayIsOverride ? overrides.reduce((sum, cost) => sum + (cost.adsGmvPayOverride || 0), 0) : Math.abs(totals.adFee);

  const wht = whtRate * (adsCard + adsGmvPay);
  const duitMasuk = totals.settlement;
  // Realized profit: settled income minus the cost of the orders that produced it.
  const nettProfit = duitMasuk - kosProdukSettled - adsCard - wht - otherCost;

  return {
    from: fromIso,
    to: toIso,
    currency,
    orderCount: counted.length,
    totalOrdersInRange: orders.length,
    totalSales,
    customerPayment: totals.customerPayment,
    duitMasuk,
    revenueAmount: totals.revenue,
    feeTaxAmount: totals.feeTax,
    shippingCostAmount: totals.shipping,
    adjustmentAmount: totals.adjustment,
    reserveAmount: totals.reserve,
    lines,
    // TikTok's own identity: settlement = revenue + fee_tax + shipping + adjustment.
    settlementDrift: totals.settlement - (totals.revenue + totals.feeTax + totals.shipping + totals.adjustment),
    lineDrift,
    settledOrders: settledOrderIds.size,
    settledTransactions: settlements.length,
    unsettledOrders: counted.length - settledOrderIds.size,
    // Cost of everything sold in the month (drives the bundle table).
    kosProduk,
    // Cost of only the settled orders — the figure netted against Duit Masuk.
    kosProdukSettled,
    settledSales,
    pendingSales: totalSales - settledSales,
    pendingOrders: counted.length - settledIds.size,
    // What share of order value TikTok actually pays out, on settled orders only.
    settlementRate: settledSales > 0 ? duitMasuk / settledSales : 0,
    adsCard,
    adsGmvPay,
    adsGmvPayIsOverride,
    adCredit,
    otherCost,
    whtRate,
    wht,
    nettProfit,
    // Like-for-like: profit on settled orders over the sales of those same orders.
    // Dividing by total sales would read as a collapsing margin mid-payout.
    profitPercentage: settledSales > 0 ? nettProfit / settledSales : 0,
    profitPercentageOfAllSales: totalSales > 0 ? nettProfit / totalSales : 0,
    marginOnSettlement: duitMasuk > 0 ? nettProfit / duitMasuk : 0,
    totalQuantity,
    unitMe,
    bundles,
    unmappedSkus: unmappedSkus.sort((a, b) => b.quantity - a.quantity),
    periods,
  };
}

export async function logWebhook({ eventType, shopId, orderId, verified, outcome, note }) {
  await ensureFinanceSchema();
  await database()`INSERT INTO tl_webhook_log (event_type, shop_id, order_id, verified, outcome, note)
    VALUES (${eventType ?? null},${shopId ?? null},${orderId ?? null},${Boolean(verified)},${outcome ?? null},${note ?? null})`;
}

/** Most recent write from either sync, so the UI can show data freshness. */
export async function lastSyncedAt(workspaceId) {
  await ensureFinanceSchema();
  const rows = await database()`SELECT greatest(
      coalesce((SELECT max(synced_at) FROM tl_shop_orders WHERE workspace_id=${workspaceId}), 'epoch'::timestamptz),
      coalesce((SELECT max(synced_at) FROM tl_settlements WHERE workspace_id=${workspaceId}), 'epoch'::timestamptz)
    ) AS at`;
  const at = rows[0]?.at;
  return at && new Date(at).getFullYear() > 1971 ? new Date(at).toISOString() : null;
}

/** Statement ids already stored, so a throttled sync resumes instead of restarting. */
export async function syncedStatementIds(workspaceId) {
  await ensureFinanceSchema();
  const rows = await database()`SELECT DISTINCT statement_id FROM tl_settlements WHERE workspace_id=${workspaceId} AND statement_id IS NOT NULL`;
  return new Set(rows.map((row) => row.statement_id));
}

/** Every SKU seen in synced orders — powers the cost-mapping UI so no SKU is typed by hand. */
export async function discoverSkus(workspaceId) {
  await ensureFinanceSchema();
  const rows = await database()`SELECT items FROM tl_shop_orders WHERE workspace_id=${workspaceId}`;
  const seen = new Map();
  for (const row of rows) {
    for (const item of row.items || []) {
      const key = skuKeyFor(item);
      const entry = seen.get(key) || { skuKey: key, productName: item.productName || null, skuName: item.skuName || null, quantity: 0 };
      entry.quantity += Number(item.quantity ?? 1) || 1;
      seen.set(key, entry);
    }
  }
  return [...seen.values()].sort((a, b) => b.quantity - a.quantity);
}
