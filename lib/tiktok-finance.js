import { callShop } from "./tiktok";

/**
 * TikTok Shop Finance API (v202501).
 *
 * An order's payment.total_amount is what the BUYER paid. What lands in the
 * seller's wallet is the settlement amount, and TikTok's own identity is:
 *
 *   settlement = revenue + fee_tax + shipping_cost + adjustment
 *
 * where fee_tax and shipping_cost arrive NEGATIVE (they are deductions). Each of
 * those four has a documented breakdown, and this module keeps the breakdown
 * intact instead of collapsing it into one "fees" number — a seller needs to see
 * that the platform commission and the GMV Max ad fee are different things.
 *
 * Notably fee.gmv_max_ad_fee_amount means GMV Max ad spend is a synced figure,
 * not something anyone has to copy out of Ads Manager by hand.
 */

/* ------------------------------------------------------------ line registry */

/**
 * Human labels for the breakdown keys TikTok can return. Anything TikTok sends
 * that is missing here is still aggregated and displayed — it falls back to a
 * de-snake-cased label — so a newly-introduced fee shows up rather than vanishing.
 */
export const LINE_LABELS = {
  // revenue_breakdown
  subtotal_before_discount_amount: "Subtotal before discount",
  seller_discount_amount: "Seller discount",
  seller_discount_refund_amount: "Seller discount refunded",
  refund_subtotal_before_discount_amount: "Refunded subtotal",
  cod_service_fee_amount: "COD service fee",
  refund_cod_service_fee_amount: "COD service fee refunded",
  distant_item_fee_amount: "Distant item fee",
  // fee_tax_breakdown.fee
  platform_commission_amount: "TikTok Shop commission",
  referral_fee_amount: "Referral fee",
  transaction_fee_amount: "Transaction fee",
  affiliate_commission_amount: "Affiliate commission",
  affiliate_ads_commission_amount: "Affiliate ads commission",
  affiliate_partner_commission_amount: "Affiliate partner commission",
  affiliate_commission_amount_before_pit: "Affiliate commission (before PIT)",
  gmv_max_ad_fee_amount: "GMV Max ad fee",
  tap_shop_ads_commission: "Tap Shop ads commission",
  external_affiliate_marketing_fee_amount: "External affiliate marketing fee",
  sfp_service_fee_amount: "Shipping fee promotion service fee",
  mall_service_fee_amount: "Mall service fee",
  live_specials_fee_amount: "Live specials fee",
  flash_sales_service_fee_amount: "Flash sales service fee",
  voucher_xtra_service_fee_amount: "Voucher Xtra service fee",
  smart_promotion_fee_amount: "Smart promotion fee",
  bonus_cashback_service_fee_amount: "Bonus cashback service fee",
  cofunded_promotion_service_fee_amount: "Co-funded promotion service fee",
  cofunded_creator_bonus_amount: "Co-funded creator bonus",
  credit_card_handling_fee_amount: "Credit card handling fee",
  seller_paylater_handling_fee_amount: "PayLater handling fee",
  dt_handling_fee_amount: "Handling fee",
  refund_administration_fee_amount: "Refund administration fee",
  fee_per_item_sold_amount: "Fee per item sold",
  dynamic_commission_amount: "Dynamic commission",
  platform_special_service_fee_amount: "Platform special service fee",
  pre_order_service_fee_amount: "Pre-order service fee",
  shipping_fee_guarantee_service_fee: "Shipping fee guarantee service fee",
  installation_service_fee: "Installation service fee",
  tsp_commission_amount: "TSP commission",
  // fee_tax_breakdown.tax
  sst_amount: "SST",
  vat_amount: "VAT",
  gst_amount: "GST",
  import_vat_amount: "Import VAT",
  customs_duty_amount: "Customs duty",
  customs_clearance_amount: "Customs clearance",
  sales_tax_referral_fee_amount: "Sales tax on referral fee",
  pit_amount: "PIT",
  // shipping_cost_breakdown
  actual_shipping_fee_amount: "Actual shipping fee",
  customer_paid_shipping_fee_amount: "Customer paid shipping",
  shipping_fee_discount_amount: "Shipping fee discount",
  shipping_insurance_fee_amount: "Shipping insurance",
  return_shipping_fee_amount: "Return shipping fee",
  return_shipping_fee_paid_buyer_amount: "Return shipping paid by buyer",
  return_shipping_label_fee_amount: "Return shipping label fee",
  exchange_shipping_fee_amount: "Exchange shipping fee",
  replacement_shipping_fee_amount: "Replacement shipping fee",
  signature_confirmation_fee_amount: "Signature confirmation fee",
  failed_delivery_subsidy_amount: "Failed delivery subsidy",
  free_return_subsidy_amount: "Free return subsidy",
  seller_self_shipping_service_fee_amount: "Self-shipping service fee",
  shipping_fee_subsidy_amount: "Shipping fee subsidy",
  platform_shipping_fee_discount_amount: "Platform shipping fee discount",
  seller_shipping_fee_discount_amount: "Seller shipping fee discount",
  customer_shipping_fee_offset_amount: "Customer shipping fee offset",
  promo_shipping_incentive_amount: "Promo shipping incentive",
  fbt_shipping_cost_amount: "Fulfilled by TikTok shipping cost",
  fbt_fulfillment_fee_amount: "Fulfilled by TikTok fulfillment fee",
  fbm_shipping_cost_amount: "Fulfilled by merchant shipping cost",
};

/** Fee keys that are advertising spend TikTok billed against GMV. Drives "Kos Ads By GMV Pay". */
export const AD_FEE_KEYS = ["gmv_max_ad_fee_amount", "affiliate_ads_commission_amount", "tap_shop_ads_commission", "external_affiliate_marketing_fee_amount"];

export function lineLabel(key) {
  return LINE_LABELS[key] || key.replace(/_amount$/, "").replace(/_/g, " ").replace(/^./, (character) => character.toUpperCase());
}

/* -------------------------------------------------------------- normalising */

function num(value) {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Flattens one breakdown object into signed lines, dropping zeroes and recursing into nested containers. */
function flatten(source, group, into) {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object") {
      // shipping_cost_breakdown nests a `supplementary_component` one level deeper.
      flatten(value, group, into);
      continue;
    }
    const amount = num(value);
    if (amount === 0) continue;
    const existing = into.find((line) => line.key === key && line.group === group);
    if (existing) existing.amount += amount;
    else into.push({ key, group, amount });
  }
}

const epochToIso = (seconds) => {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
};

export function normalizeTransaction(transaction, statement) {
  // Adjustments (chargebacks, corrections) may reference the order they belong to
  // rather than carrying one, and some carry no order at all.
  const orderId = transaction.order_id || transaction.adjustment_order_id || transaction.associated_order_id || transaction.adjustment_id || transaction.id;
  if (!orderId) return null;

  const breakdown = [];
  flatten(transaction.revenue_breakdown, "revenue", breakdown);
  flatten(transaction.fee_tax_breakdown?.fee, "fee", breakdown);
  flatten(transaction.fee_tax_breakdown?.tax, "tax", breakdown);
  flatten(transaction.shipping_cost_breakdown, "shipping", breakdown);

  const adFeeAmount = breakdown
    .filter((line) => line.group === "fee" && AD_FEE_KEYS.includes(line.key))
    .reduce((sum, line) => sum + line.amount, 0);

  return {
    // An order yields several transactions over its life (the sale, then any
    // refund adjustment), so the transaction id is what must be unique — keying
    // on order_id would let a refund overwrite the sale it refunds.
    transactionId: String(transaction.id || transaction.adjustment_id || `${orderId}:${transaction.type || "txn"}`),
    orderId: String(orderId),
    type: transaction.type || null,
    currency: transaction.currency || statement?.currency || null,
    settlementAmount: num(transaction.settlement_amount),
    revenueAmount: num(transaction.revenue_amount),
    feeTaxAmount: num(transaction.fee_tax_amount),
    shippingCostAmount: num(transaction.shipping_cost_amount),
    adjustmentAmount: num(transaction.adjustment_amount),
    reserveAmount: num(transaction.reserve_amount),
    customerPaymentAmount: num(transaction.supplementary_component?.customer_payment_amount),
    adFeeAmount,
    breakdown,
    statementId: transaction.statement_id || statement?.id || null,
    statementTime: epochToIso(transaction.statement_time ?? statement?.statement_time),
    orderCreateTime: epochToIso(transaction.order_create_time),
    raw: transaction,
  };
}

/* ---------------------------------------------------------------- endpoints */

/**
 * Payout statements in a window. Each is one bank transfer.
 *
 * NOTE the version asymmetry, which is easy to get wrong: `statements` only
 * exists at 202309, while `statement_transactions` has a newer 202501 variant
 * (with the richer breakdown this dashboard needs). Using 202501 here returns
 * "Invalid API version" rather than a not-found, so it looks like a bad
 * parameter instead of a bad path.
 */
export function getStatements({ accessToken, shopCipher, statementTimeGe, statementTimeLt, pageToken, pageSize = 50 }) {
  return callShop({
    path: "/finance/202309/statements",
    accessToken,
    query: {
      shop_cipher: shopCipher,
      page_size: pageSize,
      page_token: pageToken,
      statement_time_ge: statementTimeGe,
      statement_time_lt: statementTimeLt,
      sort_field: "statement_time",
    },
  });
}

/**
 * The transactions inside one payout statement.
 * NOTE: the response key is `transactions`, not `statement_transactions`.
 */
export function getStatementTransactions({ accessToken, shopCipher, statementId, pageToken, pageSize = 50 }) {
  return callShop({
    path: `/finance/202501/statements/${encodeURIComponent(statementId)}/statement_transactions`,
    accessToken,
    // sort_field is mandatory here despite being documented as optional, and the
    // accepted value differs per endpoint: transactions sort by order_create_time,
    // statements by statement_time. Omitting it fails the whole call.
    query: { shop_cipher: shopCipher, page_size: pageSize, page_token: pageToken, sort_field: "order_create_time" },
  });
}

/** SKU-level finance for one order — carries quantity, sku_id and sku_name. */
export function getOrderTransactions({ accessToken, shopCipher, orderId }) {
  return callShop({
    path: `/finance/202501/orders/${encodeURIComponent(orderId)}/statement_transactions`,
    accessToken,
    query: { shop_cipher: shopCipher },
  });
}

/**
 * Walks every statement in the window and every transaction inside each.
 * `maxTransactions` is a safety stop and is reported back, never applied silently.
 */
export async function fetchSettlements({ accessToken, shopCipher, statementTimeGe, statementTimeLt, maxTransactions = 5000 }) {
  const rows = [];
  const statements = [];
  let sampleTransaction = null;
  let truncated = false;
  let statementToken;
  let error = null;

  outer: do {
    const page = await getStatements({ accessToken, shopCipher, statementTimeGe, statementTimeLt, pageToken: statementToken });
    if (page.error) { error = page.error; break; }

    for (const statement of page.data?.statements || []) {
      statements.push(statement);
      if (!statement.id) continue;

      let transactionToken;
      do {
        const result = await getStatementTransactions({ accessToken, shopCipher, statementId: statement.id, pageToken: transactionToken });
        if (result.error) { error = result.error; break outer; }

        for (const transaction of result.data?.transactions || []) {
          if (!sampleTransaction) sampleTransaction = transaction;
          const normalized = normalizeTransaction(transaction, statement);
          if (normalized) rows.push(normalized);
        }
        transactionToken = result.data?.next_page_token || undefined;
        if (rows.length >= maxTransactions) { truncated = Boolean(transactionToken || page.data?.next_page_token); break outer; }
      } while (transactionToken);
    }
    statementToken = page.data?.next_page_token || undefined;
  } while (statementToken);

  return { rows, statements, sampleTransaction, truncated, error };
}
