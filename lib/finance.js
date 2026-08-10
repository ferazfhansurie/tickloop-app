import { database, ensureSchema } from "./db";
import { AD_FEE_KEYS, lineLabel } from "./tiktok-finance";

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

    // Ad-account payments from Business Center. Card spend lands here so it stops
    // being typed by hand; GMV Pay is stored too, for reconciliation.
    await q`CREATE TABLE IF NOT EXISTS tl_ad_transactions (
      workspace_id text NOT NULL REFERENCES tl_workspaces(id) ON DELETE CASCADE,
      transaction_id text NOT NULL,
      bc_id text,
      advertiser_id text,
      advertiser_name text,
      method text NOT NULL DEFAULT 'other',
      description text,
      fund_type text,
      status text,
      amount numeric NOT NULL DEFAULT 0,
      currency text,
      occurred_at timestamptz,
      raw jsonb NOT NULL DEFAULT '{}'::jsonb,
      synced_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, transaction_id)
    )`;
    await q`CREATE INDEX IF NOT EXISTS tl_ad_tx_time_idx ON tl_ad_transactions (workspace_id, occurred_at DESC)`;

    // Which creator drove each order. Only obtainable from the Affiliate export,
    // so it is imported rather than synced.
    await q`CREATE TABLE IF NOT EXISTS tl_order_affiliates (
      workspace_id text NOT NULL REFERENCES tl_workspaces(id) ON DELETE CASCADE,
      order_id text NOT NULL,
      creator text NOT NULL,
      content_type text,
      commission_base numeric NOT NULL DEFAULT 0,
      commission numeric NOT NULL DEFAULT 0,
      imported_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, order_id)
    )`;
    await q`CREATE INDEX IF NOT EXISTS tl_order_aff_creator_idx ON tl_order_affiliates (workspace_id, creator)`;

    // Fixed monthly running costs — payroll, statutory, rent, subscriptions.
    // A settlement-only P&L flatters the business because none of this is in it.
    await q`CREATE TABLE IF NOT EXISTS tl_opex (
      workspace_id text NOT NULL REFERENCES tl_workspaces(id) ON DELETE CASCADE,
      period text NOT NULL,
      category text NOT NULL,
      label text NOT NULL,
      amount numeric NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, period, category, label)
    )`;

    // Month-scoped costs TikTok Shop genuinely cannot tell us.
    await q`CREATE TABLE IF NOT EXISTS tl_period_costs (
      workspace_id text NOT NULL REFERENCES tl_workspaces(id) ON DELETE CASCADE,
      period text NOT NULL,
      ads_card numeric NOT NULL DEFAULT 0,
      ad_credit numeric NOT NULL DEFAULT 0,
      wht_rate numeric NOT NULL DEFAULT 0.10,
      other_cost numeric NOT NULL DEFAULT 0,
      ads_gmv_pay_override numeric,
      -- Cost per parcel actually shipped, and a markup applied to raw SKU cost.
      fulfilment_rate numeric NOT NULL DEFAULT 0,
      cogs_markup_pct numeric NOT NULL DEFAULT 0,
      notes text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, period)
    )`;
    // CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
    // new columns need their own migration or every query referencing them fails
    // in production while passing locally on a fresh database.
    await q`ALTER TABLE tl_period_costs ADD COLUMN IF NOT EXISTS fulfilment_rate numeric NOT NULL DEFAULT 0`;
    await q`ALTER TABLE tl_period_costs ADD COLUMN IF NOT EXISTS cogs_markup_pct numeric NOT NULL DEFAULT 0`;
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

/**
 * Starter OPEX structure. Categories come from how a Malaysian SME actually books
 * costs — payroll, statutory, then running costs — so the seller recognises the
 * shape rather than facing an empty list.
 */
export const OPEX_TEMPLATE = {
  Payroll: ["Director", "Admin", "Marketer", "Video Editor", "Packer"],
  Statutory: ["EPF", "SOCSO", "Tax"],
  Operations: ["Rent", "Utilities", "Internet", "Office supply", "Marketing tools", "Software subscription", "Other"],
};

export async function listOpex(workspaceId, period) {
  await ensureFinanceSchema();
  const rows = await database()`SELECT category, label, amount FROM tl_opex WHERE workspace_id=${workspaceId} AND period=${period} ORDER BY category, label`;
  return rows.map((row) => ({ category: row.category, label: row.label, amount: Number(row.amount) }));
}

export async function saveOpex(workspaceId, period, entries) {
  await ensureFinanceSchema();
  const q = database();
  // Replace the month wholesale: a removed line must disappear, not linger at its
  // old value because the upsert never saw it.
  await q`DELETE FROM tl_opex WHERE workspace_id=${workspaceId} AND period=${period}`;
  const keep = entries.filter((entry) => entry.label && Number(entry.amount));
  if (!keep.length) return 0;
  const params = [];
  for (const entry of keep) params.push(workspaceId, period, entry.category || "Operations", entry.label, Number(entry.amount) || 0);
  await q.query(`INSERT INTO tl_opex (workspace_id, period, category, label, amount) VALUES ${placeholders(keep.length, 5)}`, params);
  return keep.length;
}

/** OPEX for every month the range touches, totalled and grouped. */
async function opexForPeriods(workspaceId, periods) {
  if (!periods.length) return { total: 0, byCategory: {}, lines: [] };
  const rows = await database()`SELECT category, label, sum(amount) AS amount FROM tl_opex
    WHERE workspace_id=${workspaceId} AND period = ANY(${periods}) GROUP BY category, label ORDER BY category, label`;
  const lines = rows.map((row) => ({ category: row.category, label: row.label, amount: Number(row.amount) }));
  const byCategory = {};
  let total = 0;
  for (const line of lines) {
    byCategory[line.category] = Number(((byCategory[line.category] || 0) + line.amount).toFixed(2));
    total += line.amount;
  }
  return { total, byCategory, lines };
}

const toPeriodCost = (row) => ({
  period: row.period,
  adsCard: Number(row.ads_card),
  adCredit: Number(row.ad_credit),
  whtRate: Number(row.wht_rate),
  otherCost: Number(row.other_cost),
  adsGmvPayOverride: row.ads_gmv_pay_override === null || row.ads_gmv_pay_override === undefined ? null : Number(row.ads_gmv_pay_override),
  fulfilmentRate: Number(row.fulfilment_rate || 0),
  cogsMarkupPct: Number(row.cogs_markup_pct || 0),
  notes: row.notes || null,
});

export async function listPeriodCosts(workspaceId) {
  await ensureFinanceSchema();
  const rows = await database()`SELECT period, ads_card, ad_credit, wht_rate, other_cost, ads_gmv_pay_override, fulfilment_rate, cogs_markup_pct, notes FROM tl_period_costs WHERE workspace_id=${workspaceId} ORDER BY period DESC`;
  return rows.map(toPeriodCost);
}

export async function savePeriodCost(workspaceId, cost) {
  await ensureFinanceSchema();
  await database()`INSERT INTO tl_period_costs (workspace_id, period, ads_card, ad_credit, wht_rate, other_cost, ads_gmv_pay_override, fulfilment_rate, cogs_markup_pct, notes, updated_at)
    VALUES (${workspaceId},${cost.period},${cost.adsCard},${cost.adCredit},${cost.whtRate},${cost.otherCost},${cost.adsGmvPayOverride},${cost.fulfilmentRate ?? 0},${cost.cogsMarkupPct ?? 0},${cost.notes}, now())
    ON CONFLICT (workspace_id, period) DO UPDATE SET ads_card=EXCLUDED.ads_card, ad_credit=EXCLUDED.ad_credit, wht_rate=EXCLUDED.wht_rate, other_cost=EXCLUDED.other_cost, ads_gmv_pay_override=EXCLUDED.ads_gmv_pay_override, fulfilment_rate=EXCLUDED.fulfilment_rate, cogs_markup_pct=EXCLUDED.cogs_markup_pct, notes=EXCLUDED.notes, updated_at=now()`;
}

/* ------------------------------------------------------------------ the P&L */

/** Statuses that represent a sale we recognise. CANCELLED never counts. */
const REVENUE_STATUSES = ["AWAITING_SHIPMENT", "AWAITING_COLLECTION", "PARTIALLY_SHIPPING", "IN_TRANSIT", "DELIVERED", "COMPLETED"];

/**
 * Statuses where a parcel actually left the warehouse. Fulfilment is charged per
 * parcel handled, so an order still awaiting shipment must not attract the cost —
 * and a refunded one still must, because it was already packed and sent.
 */
const SHIPPED_STATUSES = new Set(["AWAITING_COLLECTION", "PARTIALLY_SHIPPING", "IN_TRANSIT", "DELIVERED", "COMPLETED"]);

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
export async function financeSummary(workspaceId, fromIso, toIso, basis = "order") {
  await ensureFinanceSchema();
  const q = database();

  // Two ways to ask the question, and they answer different ones:
  //
  //   order  — every order CREATED in the window, plus everything those orders
  //            will ever pay out, whenever it lands. "Were these sales
  //            profitable?" Costs match the same orders, so revenue and cost
  //            describe the same thing.
  //   payout — the money that actually SETTLED in the window, whenever the order
  //            was placed. "What reached the bank?" — the basis for reconciling
  //            against a bank statement.
  //
  // Mixing them silently would be the real hazard: cash-basis income against
  // order-basis costs overstates or understates margin with no visible symptom.
  const byPayout = basis === "payout";

  let orders;
  let settlements;

  if (byPayout) {
    settlements = await q`SELECT order_id, settlement_amount, revenue_amount, fee_tax_amount, shipping_cost_amount, adjustment_amount, reserve_amount, customer_payment_amount, ad_fee_amount, breakdown, currency
      FROM tl_settlements WHERE workspace_id=${workspaceId} AND statement_time >= ${fromIso} AND statement_time < ${toIso}
        AND (transaction_type IS NULL OR NOT (transaction_type = ANY(${AD_PAYMENT_TYPES})))`;
    const paidIds = [...new Set(settlements.map((row) => row.order_id))];
    orders = paidIds.length
      ? await q`SELECT order_id, status, currency, total_amount, items FROM tl_shop_orders
          WHERE workspace_id=${workspaceId} AND order_id = ANY(${paidIds})`
      : [];
  } else {
    orders = await q`SELECT order_id, status, currency, total_amount, items FROM tl_shop_orders
      WHERE workspace_id=${workspaceId} AND create_time >= ${fromIso} AND create_time < ${toIso}`;
  }

  const counted = orders.filter((order) => REVENUE_STATUSES.includes(String(order.status).toUpperCase()));
  const orderIds = counted.map((order) => order.order_id);

  let unmatchedPayout = 0;
  let unmatchedPayoutOrders = 0;
  if (byPayout) {
    // Keep only settlements whose order we actually hold, so income, sales and
    // cost describe the same orders. What that excludes is reported rather than
    // dropped: it is real money, just money we cannot attribute.
    const countedIds = new Set(orderIds);
    const matched = [];
    const seenUnmatched = new Set();
    for (const row of settlements) {
      if (countedIds.has(row.order_id)) { matched.push(row); continue; }
      unmatchedPayout += Number(row.settlement_amount) || 0;
      seenUnmatched.add(row.order_id);
    }
    unmatchedPayoutOrders = seenUnmatched.size;
    settlements = matched;
  } else {
    settlements = orderIds.length
      ? await q`SELECT order_id, settlement_amount, revenue_amount, fee_tax_amount, shipping_cost_amount, adjustment_amount, reserve_amount, customer_payment_amount, ad_fee_amount, breakdown, currency
          FROM tl_settlements WHERE workspace_id=${workspaceId} AND order_id = ANY(${orderIds})`
      : [];
  }

  const rawCosts = await listProductCosts(workspaceId);

  // Which orders TikTok has actually paid out on. Duit Masuk only covers these,
  // so the costs netted against it must cover exactly the same orders — otherwise
  // a month mid-payout shows income from the settled few minus the cost of all.
  const settledIds = new Set(settlements.map((row) => row.order_id));

  const periodsForCosts = monthsBetween(new Date(fromIso), new Date(toIso));
  const periodRowsEarly = periodsForCosts.length
    ? await q`SELECT period, ads_card, ad_credit, wht_rate, other_cost, ads_gmv_pay_override, fulfilment_rate, cogs_markup_pct, notes FROM tl_period_costs WHERE workspace_id=${workspaceId} AND period = ANY(${periodsForCosts})`
    : [];
  const periodCostsEarly = periodRowsEarly.map(toPeriodCost);
  // A markup lets a group bill subsidiaries above raw cost while finance still
  // sees the true figure. Zero by default, so nothing changes unless it is set.
  const markupPct = periodCostsEarly.length ? periodCostsEarly[0].cogsMarkupPct : 0;
  const costs = rawCosts.map((cost) => ({ ...cost, unitCost: Number((cost.unitCost * (1 + markupPct / 100)).toFixed(4)) }));
  const costBySku = new Map(costs.map((cost) => [cost.skuKey, cost]));

  const quantityBySku = new Map();
  const quantityBySkuSettled = new Map();
  let totalSales = 0;
  let settledSales = 0;
  let currency = "MYR";

  let shippedParcels = 0;
  for (const order of counted) {
    const amount = Number(order.total_amount) || 0;
    totalSales += amount;
    if (SHIPPED_STATUSES.has(String(order.status).toUpperCase())) shippedParcels += 1;
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
  const periodCosts = periodCostsEarly;

  const manualAdsCard = periodCosts.reduce((sum, cost) => sum + cost.adsCard, 0);
  // Business Center is authoritative for card spend when connected; the typed
  // figure stays as the fallback so nothing silently drops to zero if a sync fails.
  const adSpend = await adSpendInRange(workspaceId, fromIso, toIso);
  const adsCardIsSynced = adSpend.connected && adSpend.card > 0;
  const adsCard = adsCardIsSynced ? adSpend.card : manualAdsCard;
  const adCredit = periodCosts.reduce((sum, cost) => sum + cost.adCredit, 0);
  const otherCost = periodCosts.reduce((sum, cost) => sum + cost.otherCost, 0);
  const whtRate = periodCosts.length ? periodCosts[0].whtRate : DEFAULT_WHT_RATE;

  // GMV Pay is synced from TikTok's ad fees. An override exists because a seller
  // reconciling against an invoice must be able to win an argument with the API.
  const overrides = periodCosts.filter((cost) => cost.adsGmvPayOverride !== null);
  const adsGmvPayIsOverride = overrides.length > 0;
  // GMV Pay, in order of trustworthiness: a manual override, then TikTok's own
  // payout deductions, then Business Center, and only then the settlement fee
  // proxy — which on this shop was affiliate ads commission, not GMV Pay at all.
  const gmvPayDeducted = await gmvPayInRange(workspaceId, fromIso, toIso);
  const adsGmvPay = adsGmvPayIsOverride
    ? overrides.reduce((sum, cost) => sum + (cost.adsGmvPayOverride || 0), 0)
    : gmvPayDeducted.amount > 0 ? gmvPayDeducted.amount
    : adSpend.gmvPay > 0 ? adSpend.gmvPay
    : Math.abs(totals.adFee);
  const adsGmvPayIsSynced = !adsGmvPayIsOverride && (gmvPayDeducted.amount > 0 || adSpend.gmvPay > 0);
  // Whether GMV Pay is deducted is a fact about the shop, not about where the
  // number came from: an override changes the amount, never the treatment.
  // Tying this to `!isOverride` silently stopped subtracting a real cost the
  // moment someone typed a figure.
  const gmvPayIsDeductedFromPayout = gmvPayDeducted.amount > 0;
  // An override that disagrees with the measured deduction is worth saying out
  // loud — it is understating or overstating profit by exactly the difference.
  const gmvPayOverrideDrift = adsGmvPayIsOverride && gmvPayDeducted.amount > 0
    ? Number((adsGmvPay - gmvPayDeducted.amount).toFixed(2))
    : 0;
  // Which ad fees this figure is actually made of. On a shop with no GMV Max the
  // whole amount is affiliate ads commission, and calling it "GMV Pay" overstates
  // what has been measured — Business Center is the only source for real GMV Pay.
  const adFeeSources = lines.filter((line) => line.group === "fee" && AD_FEE_KEYS.includes(line.key)).map((line) => line.label);

  const fulfilmentRate = periodCosts.length ? periodCosts[0].fulfilmentRate : 0;
  const fulfilmentCost = fulfilmentRate * shippedParcels;
  const opex = await opexForPeriods(workspaceId, periods);

  const wht = whtRate * (adsCard + adsGmvPay);
  const duitMasuk = totals.settlement;
  // Realized profit: settled income minus the cost of the orders that produced it.
  // Operating profit is the settlement-level result; net profit then carries the
  // fixed running costs, which is the number that says whether the business works.
  const operatingProfit = duitMasuk - kosProdukSettled - adsCard - wht - otherCost - (gmvPayIsDeductedFromPayout ? adsGmvPay : 0);
  const nettProfit = operatingProfit - fulfilmentCost - opex.total;

  const leaderboard = await creatorLeaderboard(workspaceId, orderIds, costBySku);

  return {
    from: fromIso,
    to: toIso,
    basis,
    leaderboard,
    attributedOrders: leaderboard.reduce((sum, entry) => sum + entry.orders, 0),
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
    markupPct,
    shippedParcels,
    fulfilmentRate,
    fulfilmentCost,
    opexTotal: opex.total,
    opexByCategory: opex.byCategory,
    opexLines: opex.lines,
    operatingProfit,
    settledSales,
    pendingSales: byPayout ? 0 : totalSales - settledSales,
    pendingOrders: byPayout ? 0 : Math.max(0, counted.length - settledIds.size),
    unmatchedPayout: Number(unmatchedPayout.toFixed(2)),
    unmatchedPayoutOrders,
    // What share of order value TikTok actually pays out, on settled orders only.
    settlementRate: settledSales > 0 ? duitMasuk / settledSales : 0,
    adsCard,
    adsCardIsSynced,
    manualAdsCard,
    adSpend,
    adsGmvPay,
    adsGmvPayIsOverride,
    adsGmvPayIsSynced,
    gmvPayIsDeductedFromPayout,
    gmvPayTransactions: gmvPayDeducted.count,
    gmvPayMeasured: gmvPayDeducted.amount,
    gmvPayOverrideDrift,
    adFeeSources,
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

/**
 * Keys stored by an earlier sync that RESTATE another line rather than adding
 * money. Four of them live under `shipping_cost_breakdown.supplementary_component`,
 * which the normaliser no longer descends into, and one restates the affiliate
 * commission before PIT.
 *
 * Verified against the live shop: removing exactly these makes each group's
 * subtotal equal the amount TikTok reports (fee -34,984.51 and shipping -70.20,
 * where the stored breakdown summed to -36,895.78 and +13,845.40).
 */
const RESTATED_KEYS = [
  "affiliate_commission_amount_before_pit",
  "platform_shipping_fee_discount_amount",
  "customer_shipping_fee",
  "refunded_customer_shipping_fee_amount",
  "refund_customer_shipping_fee",
];

/**
 * Strips restated lines from breakdowns already in the database.
 *
 * This is a transformation of stored JSON, not a re-fetch: re-syncing with
 * refresh=1 would re-read every statement from TikTok and, on a shop with
 * thousands of transactions, exceed the function time limit before finishing.
 * Rows written after the normaliser fix are already clean and are left alone.
 */
export async function repairBreakdowns(workspaceId) {
  await ensureFinanceSchema();
  const q = database();
  const [before] = await q`SELECT count(*) AS rows FROM tl_settlements s
    WHERE s.workspace_id = ${workspaceId}
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.breakdown) l WHERE l->>'key' = ANY(${RESTATED_KEYS}))`;

  await q`UPDATE tl_settlements s SET breakdown = (
      SELECT coalesce(jsonb_agg(l), '[]'::jsonb) FROM jsonb_array_elements(s.breakdown) l
      WHERE NOT (l->>'key' = ANY(${RESTATED_KEYS}))
    )
    WHERE s.workspace_id = ${workspaceId}
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.breakdown) l WHERE l->>'key' = ANY(${RESTATED_KEYS}))`;

  return { repaired: Number(before.rows) };
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

export async function saveAdTransactions(workspaceId, rows) {
  await ensureFinanceSchema();
  const q = database();
  for (const batch of chunk(rows, BATCH)) {
    const params = [];
    for (const row of batch) {
      params.push(workspaceId, row.transactionId, row.bcId, row.advertiserId, row.advertiserName, row.method, row.description, row.fundType, row.status, row.amount, row.currency, row.occurredAt, JSON.stringify(row.raw));
    }
    await q.query(
      `INSERT INTO tl_ad_transactions (workspace_id, transaction_id, bc_id, advertiser_id, advertiser_name, method, description, fund_type, status, amount, currency, occurred_at, raw)
       VALUES ${placeholders(batch.length, 13, { 12: "::jsonb" })}
       ON CONFLICT (workspace_id, transaction_id) DO UPDATE SET method=EXCLUDED.method, description=EXCLUDED.description, fund_type=EXCLUDED.fund_type, status=EXCLUDED.status, amount=EXCLUDED.amount, currency=EXCLUDED.currency, occurred_at=EXCLUDED.occurred_at, raw=EXCLUDED.raw, synced_at=now()`,
      params,
    );
  }
  return rows.length;
}

/**
 * Transaction types where TikTok deducts ad spend straight out of the payout.
 * They arrive as standalone settlement rows carrying no order, so every
 * order-joined query misses them — which is exactly how they went unnoticed.
 */
const AD_PAYMENT_TYPES = ["GMV_PAYMENT_FOR_TIKTOK_ADS"];

/**
 * GMV Pay taken out of payouts in a window.
 *
 * This is real ad spend and it must be subtracted: because these rows have no
 * order_id they never join to the order cohort, so Duit Masuk is reported
 * *before* the deduction even though the bank received it after.
 */
export async function gmvPayInRange(workspaceId, fromIso, toIso) {
  await ensureFinanceSchema();
  const rows = await database()`SELECT coalesce(sum(settlement_amount),0) AS total, count(*) AS n
    FROM tl_settlements WHERE workspace_id=${workspaceId} AND transaction_type = ANY(${AD_PAYMENT_TYPES})
      AND statement_time >= ${fromIso} AND statement_time < ${toIso}`;
  return { amount: Math.abs(Number(rows[0]?.total) || 0), count: Number(rows[0]?.n) || 0 };
}

/** Ad spend in a window, split by how it was funded. */
export async function adSpendInRange(workspaceId, fromIso, toIso) {
  await ensureFinanceSchema();
  const rows = await database()`SELECT method, round(sum(amount),2) AS total, count(*) AS n
    FROM tl_ad_transactions WHERE workspace_id=${workspaceId} AND occurred_at >= ${fromIso} AND occurred_at < ${toIso}
    GROUP BY method`;
  const out = { card: 0, gmvPay: 0, credit: 0, other: 0, count: 0, connected: rows.length > 0 };
  for (const row of rows) {
    const value = Math.abs(Number(row.total) || 0);
    if (row.method === "card") out.card = value;
    else if (row.method === "gmv_pay") out.gmvPay = value;
    else if (row.method === "credit") out.credit = value;
    else out.other = value;
    out.count += Number(row.n) || 0;
  }
  return out;
}

export async function saveAttributions(workspaceId, rows) {
  await ensureFinanceSchema();
  const q = database();
  for (const batch of chunk(rows, BATCH)) {
    const params = [];
    for (const row of batch) params.push(workspaceId, row.orderId, row.creator, row.contentType, row.commissionBase, row.commission);
    await q.query(
      `INSERT INTO tl_order_affiliates (workspace_id, order_id, creator, content_type, commission_base, commission)
       VALUES ${placeholders(batch.length, 6)}
       ON CONFLICT (workspace_id, order_id) DO UPDATE SET creator=EXCLUDED.creator, content_type=EXCLUDED.content_type, commission_base=EXCLUDED.commission_base, commission=EXCLUDED.commission, imported_at=now()`,
      params,
    );
  }
  return rows.length;
}

/**
 * Per-creator P&L for the window.
 *
 * Costs are attributed the same way the headline P&L does it — settled orders
 * only — so a creator is never charged for stock on an order TikTok has not paid
 * out yet.
 */
export async function creatorLeaderboard(workspaceId, orderIds, costBySku) {
  await ensureFinanceSchema();
  if (!orderIds.length) return [];
  const q = database();
  // Commission comes from settlement, not from the import: the export carries an
  // estimate, while the settlement line is what TikTok actually paid the creator.
  const rows = await q`SELECT a.creator, a.content_type, a.commission AS estimated_commission,
      o.order_id, o.total_amount, o.items,
      coalesce(s.settled, 0) AS settled, (s.order_id IS NOT NULL) AS is_settled,
      coalesce(s.affiliate_commission, 0) AS actual_commission
    FROM tl_order_affiliates a
    JOIN tl_shop_orders o ON o.order_id = a.order_id AND o.workspace_id = a.workspace_id
    LEFT JOIN (
      SELECT t.order_id,
             sum(t.settlement_amount) AS settled,
             coalesce(sum((
               SELECT sum((l->>'amount')::numeric) FROM jsonb_array_elements(t.breakdown) l
               WHERE l->>'key' IN ('affiliate_commission_amount','affiliate_ads_commission_amount','affiliate_partner_commission_amount')
             )), 0) AS affiliate_commission
      FROM tl_settlements t WHERE t.workspace_id=${workspaceId} GROUP BY t.order_id
    ) s ON s.order_id = o.order_id
    WHERE a.workspace_id=${workspaceId} AND o.order_id = ANY(${orderIds})`;

  const byCreator = new Map();
  for (const row of rows) {
    const entry = byCreator.get(row.creator) || {
      creator: row.creator, orders: 0, settledOrders: 0, sales: 0, settlement: 0, cogs: 0, commission: 0, units: 0, contentTypes: new Set(),
    };
    entry.orders += 1;
    entry.sales += Number(row.total_amount) || 0;
    // Actual paid commission where the order has settled; the import's estimate
    // only as a stand-in for orders TikTok has not paid out yet.
    entry.commission += row.is_settled
      ? Math.abs(Number(row.actual_commission) || 0)
      : Math.abs(Number(row.estimated_commission) || 0);
    if (row.content_type) entry.contentTypes.add(row.content_type);
    if (row.is_settled) {
      entry.settledOrders += 1;
      entry.settlement += Number(row.settled) || 0;
      for (const item of row.items || []) {
        const quantity = Number(item.quantity ?? 1) || 1;
        entry.units += quantity;
        const key = String(item.sellerSku || item.skuId || item.skuName || item.productName || "unknown").trim();
        const cost = costBySku.get(key);
        if (cost) entry.cogs += quantity * cost.unitCost;
      }
    }
    byCreator.set(row.creator, entry);
  }

  return [...byCreator.values()]
    .map((entry) => ({
      ...entry,
      contentTypes: [...entry.contentTypes],
      // Commission is already inside the settlement figure, so it is reported as
      // cost-of-creator, not subtracted again.
      profit: entry.settlement - entry.cogs,
      margin: entry.settlement > 0 ? (entry.settlement - entry.cogs) / entry.settlement : 0,
      commissionRate: entry.sales > 0 ? entry.commission / entry.sales : 0,
    }))
    .sort((a, b) => b.profit - a.profit);
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
