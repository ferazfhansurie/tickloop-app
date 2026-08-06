"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Laid out as spreadsheet grids, because that is the form the seller already
// reconciles in. The values come from TikTok Shop's own finance model wherever
// TikTok exposes them, so this reconciles against Seller Center rather than
// approximating it.

const GROUP_LABELS = { revenue: "Revenue", fee: "Fees & commissions", tax: "Tax", shipping: "Shipping", adjustment: "Adjustments" };
const GROUP_ORDER = ["revenue", "fee", "tax", "shipping", "adjustment"];

function monthValue(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
function monthOptions() {
  const options = [];
  const cursor = new Date();
  for (let index = 0; index < 14; index += 1) {
    const value = monthValue(cursor);
    options.push({ value, label: new Date(`${value}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" }) });
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  return options;
}
function monthRange(period) {
  const [year, month] = period.split("-").map(Number);
  return { from: new Date(Date.UTC(year, month - 1, 1)).toISOString(), to: new Date(Date.UTC(year, month, 1)).toISOString() };
}

export default function FinancePage() {
  const months = useMemo(monthOptions, []);
  const [period, setPeriod] = useState(months[0].value);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [showCosts, setShowCosts] = useState(false);

  const money = useCallback(
    (value) => {
      const currency = data?.currency || "MYR";
      const amount = Number(value) || 0;
      const formatted = Math.abs(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return `${amount < 0 ? "-" : ""}${currency === "MYR" ? "RM" : `${currency} `}${formatted}`;
    },
    [data?.currency],
  );

  const load = useCallback(
    async (sync) => {
      const { from, to } = monthRange(period);
      if (sync) setSyncing(true); else setLoading(true);
      setError("");
      try {
        const query = new URLSearchParams({ from, to });
        if (sync) query.set("sync", "1");
        const response = await fetch(`/api/finance/summary?${query}`, { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) {
          setError(payload.error || "Could not load the dashboard.");
          if (!sync) setData(null);
          return;
        }
        setData(payload);
      } catch (caught) {
        setError(caught.message || "Could not reach the server.");
      } finally {
        setSyncing(false);
        setLoading(false);
      }
    },
    [period],
  );

  useEffect(() => { load(false); }, [load]);

  const settledPercent = data && data.orderCount > 0 ? (data.settledOrders / data.orderCount) * 100 : 0;
  const partial = data && data.pendingOrders > 0;

  return (
    <main className="finShell">
      <header className="finHeader">
        <div>
          <p className="eyebrow">TIKTOK SHOP · {data?.currency || "MYR"}</p>
          <h1>Financial dashboard</h1>
        </div>
        <div className="finControls">
          <select value={period} onChange={(event) => setPeriod(event.target.value)} aria-label="Month">
            {months.map((month) => <option key={month.value} value={month.value}>{month.label}</option>)}
          </select>
          <button className="finGhost" onClick={() => setShowCosts((open) => !open)}>{showCosts ? "Hide cost setup" : "Cost setup"}</button>
          <button className="primary" onClick={() => load(true)} disabled={syncing}>{syncing ? "Syncing…" : "Sync TikTok"}</button>
          <a className="finBack" href="/">Back</a>
        </div>
      </header>

      {error && <p className="finError">{error}</p>}
      {data?.sync?.errors?.length > 0 && data.sync.errors.map((message) => <p key={message} className="finWarn">{message}</p>)}
      {data?.sync && !data.sync.errors.length && (
        <p className="finOk">
          Synced {data.sync.orders} orders and {data.sync.settlements} settlement transactions from {data.sync.statements} payout statements
          {data.sync.statementsSkipped ? ` (${data.sync.statementsSkipped} already stored)` : ""}
          {data.sync.sellerName ? ` · ${data.sync.sellerName}` : ""}.
        </p>
      )}
      {loading && !data && <p className="finMuted">Loading…</p>}

      {data && (
        <>
          {data.lineDrift?.length > 0 && (
            <p className="finWarn">
              A breakdown subtotal does not match the total TikTok reports for it
              ({data.lineDrift.map((entry) => `${entry.group} off by ${money(entry.drift)}`).join(", ")}).
              A line is being double-counted or missed — trust Duit Masuk over the breakdown until this is fixed.
            </p>
          )}
          {Math.abs(data.settlementDrift) > 0.05 && (
            <p className="finWarn">
              Revenue + fees + shipping + adjustments is off from the reported settlement by {money(data.settlementDrift)}. Treat the breakdown as indicative and Duit Masuk as authoritative.
            </p>
          )}
          {partial && (
            <p className="finWarn">
              <b>This month is still paying out.</b> {data.settledOrders} of {data.orderCount} orders have settled
              ({settledPercent.toFixed(0)}%), leaving {money(data.pendingSales)} of sales pending. The P&amp;L below covers only
              settled orders, so it is a true margin on money received — not the month&apos;s final result.
            </p>
          )}
          {data.unmappedSkus.length > 0 && (
            <p className="finWarn">
              {data.unmappedSkus.length} SKU{data.unmappedSkus.length === 1 ? " has" : "s have"} no product cost mapped
              ({data.unmappedSkus.slice(0, 3).map((sku) => sku.skuKey).join(", ")}{data.unmappedSkus.length > 3 ? "…" : ""}).
              Kos Produk reads low and profit reads high until you map {data.unmappedSkus.length === 1 ? "it" : "them"} in Cost setup.
            </p>
          )}

          {/* ---- headline cells ---- */}
          <section className="finBoxRow">
            <Box label="Total Sales (Order Amount)" value={money(data.totalSales)} note={`${data.orderCount} orders`} />
            <Box label="Duit Masuk (Total settlement)" value={money(data.duitMasuk)} note={`${data.settledOrders} of ${data.orderCount} settled`} />
            <Box label="Nett Profit" value={money(data.nettProfit)} note={`${(data.profitPercentage * 100).toFixed(2)}% on settled sales`} tone={data.nettProfit < 0 ? "bad" : "good"} />
            <Box label="Unit ME" value={data.unitMe.toLocaleString()} note={`${data.totalQuantity.toLocaleString()} units sold`} />
          </section>

          {showCosts && <CostSetup data={data} money={money} period={period} onSaved={() => load(false)} />}

          {/* ---- P&L sheet ---- */}
          <section className="finSheet">
            <div className="finSheetHead">
              <h2>Profit &amp; loss</h2>
              <p>Each row is marked with where the number comes from, so measured and typed values are never confused.</p>
            </div>
            <div className="finScroll">
              <table className="finGridTable finPLTable">
                <thead>
                  <tr><th className="finRowHead">Item</th><th>Amount</th><th>Source</th><th>Basis</th></tr>
                </thead>
                <tbody>
                  <Row label="Total Sales (Order Amount)" amount={money(data.totalSales)} source="tiktok" basis={`all ${data.orderCount} orders`} />
                  {data.pendingSales > 0 && <Row label="Less: sales not yet settled" amount={money(-data.pendingSales)} source="tiktok" basis={`${data.pendingOrders} orders pending`} deduct />}
                  <Row label="Settled sales" amount={money(data.settledSales)} source="tiktok" basis={`${data.settledOrders} settled orders`} subtotal />
                  <Row label="Duit Masuk (Total settlement)" amount={money(data.duitMasuk)} source="tiktok" basis={`${(data.settlementRate * 100).toFixed(1)}% of settled sales`} subtotal />
                  <Row label="Kos Produk" amount={money(-data.kosProdukSettled)} source="manual" basis="settled orders only" deduct />
                  <Row label="Kos Ads By Card" amount={money(-data.adsCard)} source="manual" basis="Ads Manager, whole month" deduct />
                  <Row label="Kos Ads By GMV Pay" amount={money(data.adsGmvPay)} source={data.adsGmvPayIsOverride ? "manual" : "tiktok"} basis="already inside settlement" />
                  <Row label="Ad Credit" amount={money(data.adCredit)} source="manual" basis="not netted off profit" />
                  {data.otherCost !== 0 && <Row label="Other cost" amount={money(-data.otherCost)} source="manual" basis="whole month" deduct />}
                  <Row label={`WHT ${(data.whtRate * 100).toFixed(0)}% (To Pay)`} amount={money(-data.wht)} source="calc" basis="on card + GMV Pay ads" deduct />
                </tbody>
                <tfoot>
                  <tr className="finTotalRow">
                    <th className="finRowHead">Nett Profit</th>
                    <td className={data.nettProfit < 0 ? "finDeduct" : ""}>{money(data.nettProfit)}</td>
                    <td colSpan={2}>{(data.profitPercentage * 100).toFixed(2)}% of settled sales</td>
                  </tr>
                  <tr>
                    <th className="finRowHead finSubHead">Margin on money received</th>
                    <td>{(data.marginOnSettlement * 100).toFixed(2)}%</td>
                    <td colSpan={2} className="finMuted">Nett Profit ÷ Duit Masuk</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="finFootnote">
              Nett Profit = Duit Masuk − Kos Produk − Kos Ads By Card − WHT{data.otherCost !== 0 ? " − Other cost" : ""}.
              Kos Produk covers only settled orders, matching Duit Masuk — netting the cost of unsettled orders against settled income would invent a loss.
              GMV Pay is <b>not</b> subtracted again: TikTok charges it as a fee inside the settlement, so it is already absent from Duit Masuk. It still drives WHT.
            </p>
          </section>

          {/* ---- bundles sheet ---- */}
          <section className="finSheet">
            <div className="finSheetHead">
              <h2>Quantity by bundle</h2>
              <p>Everything sold this month. Unit ME counts bottles, so trial sachets set to 0 bottles never inflate it.</p>
            </div>
            <div className="finScroll">
              <table className="finGridTable">
                <thead>
                  <tr><th className="finRowHead">Bundle</th><th>Qty</th><th>Unit cost</th><th>Bottles</th><th>Kos Produk</th></tr>
                </thead>
                <tbody>
                  {data.bundles.length === 0 && <tr><td colSpan={5} className="finEmpty">No orders in this month yet.</td></tr>}
                  {data.bundles.map((bundle) => (
                    <tr key={bundle.bundle} className={bundle.matched ? "" : "finUnmapped"}>
                      <th className="finRowHead">{bundle.bundle}{!bundle.matched && <small>no cost mapped</small>}</th>
                      <td>{bundle.quantity.toLocaleString()}</td>
                      <td>{bundle.matched ? money(bundle.unitCost) : "—"}</td>
                      <td>{bundle.matched ? (bundle.bottles * bundle.quantity).toLocaleString() : "—"}</td>
                      <td>{bundle.matched ? money(bundle.totalCost) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="finTotalRow">
                    <th className="finRowHead">Total</th>
                    <td>{data.totalQuantity.toLocaleString()}</td>
                    <td>—</td>
                    <td>{data.unitMe.toLocaleString()}</td>
                    <td>{money(data.kosProduk)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          <SettlementSheet data={data} money={money} />
        </>
      )}
    </main>
  );
}

function Box({ label, value, note, tone }) {
  return (
    <article className={`finBox${tone ? ` finBox-${tone}` : ""}`}>
      <span>{label}</span>
      <b>{value}</b>
      <small>{note}</small>
    </article>
  );
}

const SOURCE_LABEL = { tiktok: "TikTok", manual: "Manual", calc: "Calculated" };

function Row({ label, amount, source, basis, deduct, subtotal }) {
  return (
    <tr className={subtotal ? "finSubtotalRow" : ""}>
      <th className="finRowHead">{label}</th>
      <td className={deduct ? "finDeduct" : ""}>{amount}</td>
      <td><span className={`finTag ${source}`}>{SOURCE_LABEL[source]}</span></td>
      <td className="finMuted">{basis}</td>
    </tr>
  );
}

/**
 * TikTok's own settlement arithmetic, row by row. This is the part a spreadsheet
 * can only show as one lump: it makes visible whether margin is going to
 * commission, affiliate payouts, GMV Max ads or shipping.
 */
function SettlementSheet({ data, money }) {
  const base = Math.abs(data.revenueAmount) || Math.abs(data.settledSales) || 1;

  return (
    <section className="finSheet">
      <div className="finSheetHead finSheetHeadRow">
        <div>
          <h2>TikTok Shop settlement breakdown</h2>
          <p>Every fee TikTok took, exactly as it reports them. Deductions are negative.</p>
        </div>
        <span className="finMuted">{data.settledOrders} settled orders · {data.settledTransactions} transactions</span>
      </div>

      {data.lines.length === 0 ? (
        <p className="finEmpty finEmptyPad">No settlement data for this month yet. Payouts appear after TikTok closes the statement.</p>
      ) : (
        <div className="finScroll">
          <table className="finGridTable">
            <thead>
              <tr><th className="finRowHead">Line</th><th>Amount</th><th>Share of revenue</th></tr>
            </thead>
            {GROUP_ORDER.map((group) => {
              const lines = data.lines.filter((line) => line.group === group);
              if (!lines.length) return null;
              const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
              return (
                <tbody key={group}>
                  <tr className="finGroupRow"><th className="finRowHead" colSpan={2}>{GROUP_LABELS[group]}</th><td>{money(subtotal)}</td></tr>
                  {lines.map((line) => {
                    const share = Math.min(100, (Math.abs(line.amount) / base) * 100);
                    return (
                      <tr key={`${line.group}:${line.key}`}>
                        <th className="finRowHead finIndent" title={line.key}>{line.label}</th>
                        <td className={line.amount < 0 ? "finDeduct" : ""}>{money(line.amount)}</td>
                        <td>
                          <span className="finCellBar">
                            <i className={line.amount < 0 ? "down" : "up"} style={{ width: `${share.toFixed(1)}%` }} />
                            <em>{share.toFixed(1)}%</em>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              );
            })}
            <tfoot>
              <tr className="finTotalRow"><th className="finRowHead">Duit Masuk (Total settlement)</th><td>{money(data.duitMasuk)}</td><td /></tr>
              {data.reserveAmount !== 0 && (
                <tr><th className="finRowHead finSubHead">Held in reserve (not yet paid out)</th><td>{money(data.reserveAmount)}</td><td /></tr>
              )}
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

/** Cost setup: the only numbers TikTok Shop cannot tell us. */
function CostSetup({ data, money, period, onSaved }) {
  const [products, setProducts] = useState([]);
  const [periodCost, setPeriodCost] = useState({ period, adsCard: 0, adCredit: 0, whtRate: 0.1, otherCost: 0, adsGmvPayOverride: null, notes: null });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  // Seed the SKU rows from what has actually been sold, so nothing is typed by hand.
  useEffect(() => {
    const existing = new Map((data.productCosts || []).map((cost) => [cost.skuKey, cost]));
    const rows = (data.skus || []).map((sku, index) => {
      const found = existing.get(sku.skuKey);
      return {
        skuKey: sku.skuKey,
        label: sku.skuName || sku.productName || sku.skuKey,
        bundle: found?.bundle || sku.skuName || sku.productName || sku.skuKey,
        unitCost: found?.unitCost ?? 0,
        bottles: found?.bottles ?? 0,
        sortOrder: found?.sortOrder ?? index,
        quantity: sku.quantity,
      };
    });
    for (const cost of data.productCosts || []) {
      if (!rows.some((row) => row.skuKey === cost.skuKey)) rows.push({ ...cost, label: cost.bundle, quantity: 0 });
    }
    setProducts(rows);
  }, [data.productCosts, data.skus]);

  useEffect(() => {
    const found = (data.periodCosts || []).find((cost) => cost.period === period);
    setPeriodCost(found || { period, adsCard: 0, adCredit: 0, whtRate: 0.1, otherCost: 0, adsGmvPayOverride: null, notes: null });
  }, [data.periodCosts, period]);

  const update = (index, patch) => setProducts((rows) => rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/finance/costs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ products, period: periodCost }),
      });
      const payload = await response.json();
      if (!response.ok) { setMessage(payload.error || "Could not save."); return; }
      setMessage("Saved.");
      onSaved();
    } catch (error) {
      setMessage(error.message || "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  const syncedGmvPay = data.adsGmvPayIsOverride ? 0 : data.adsGmvPay;
  const effectiveGmvPay = periodCost.adsGmvPayOverride ?? syncedGmvPay;

  return (
    <section className="finSheet finCostSheet">
      <div className="finSheetHead">
        <h2>Cost setup</h2>
        <p>The only numbers TikTok Shop cannot supply: what each bundle costs to make, and ad spend billed to a card in Ads Manager.</p>
      </div>

      <div className="finScroll">
        <table className="finGridTable finEditable">
          <thead>
            <tr><th className="finRowHead">SKU</th><th>TikTok name</th><th>Bundle name</th><th>Unit cost</th><th>Bottles</th><th>Sold</th></tr>
          </thead>
          <tbody>
            {products.length === 0 && <tr><td colSpan={6} className="finEmpty">No SKUs yet — hit Sync TikTok first.</td></tr>}
            {products.map((product, index) => (
              <tr key={product.skuKey}>
                <th className="finRowHead"><code>{product.skuKey}</code></th>
                <td className="finMuted finNameCell">{product.label}</td>
                <td><input value={product.bundle} onChange={(event) => update(index, { bundle: event.target.value })} /></td>
                <td><input type="number" step="0.01" value={product.unitCost} onChange={(event) => update(index, { unitCost: Number(event.target.value) })} /></td>
                <td><input type="number" step="1" value={product.bottles} onChange={(event) => update(index, { bottles: Number(event.target.value) })} /></td>
                <td>{product.quantity.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="finSheetHead finSheetDivider">
        <h3>Ad spend &amp; tax — {period}</h3>
        <p>GMV Pay syncs from TikTok&apos;s GMV Max ad fee. Card-billed spend and ad credits live in TikTok Ads Manager, which a TikTok Shop authorization cannot reach.</p>
      </div>
      <div className="finFields">
        <label>Kos Ads By Card<input type="number" step="0.01" value={periodCost.adsCard} onChange={(event) => setPeriodCost({ ...periodCost, adsCard: Number(event.target.value) })} /></label>
        <div className="finField">
          <div className="finFieldHead">
            <span>Kos Ads By GMV Pay</span>
            <button className="finLink" onClick={() => setPeriodCost({ ...periodCost, adsGmvPayOverride: periodCost.adsGmvPayOverride === null ? Number(syncedGmvPay.toFixed(2)) : null })}>
              {periodCost.adsGmvPayOverride === null ? "Override" : "Use synced"}
            </button>
          </div>
          {periodCost.adsGmvPayOverride === null
            ? <><b>{money(syncedGmvPay)}</b><small className="finFromTikTok">Synced from TikTok</small></>
            : <input type="number" step="0.01" value={periodCost.adsGmvPayOverride} onChange={(event) => setPeriodCost({ ...periodCost, adsGmvPayOverride: Number(event.target.value) })} />}
        </div>
        <label>Ad Credit<input type="number" step="0.01" value={periodCost.adCredit} onChange={(event) => setPeriodCost({ ...periodCost, adCredit: Number(event.target.value) })} /></label>
        <label>Other cost<input type="number" step="0.01" value={periodCost.otherCost} onChange={(event) => setPeriodCost({ ...periodCost, otherCost: Number(event.target.value) })} /></label>
        <label>WHT rate (%)<input type="number" step="0.1" value={(periodCost.whtRate * 100).toFixed(1)} onChange={(event) => setPeriodCost({ ...periodCost, whtRate: Number(event.target.value) / 100 })} /></label>
        <div className="finField"><span>WHT to pay</span><b>{money(periodCost.whtRate * (periodCost.adsCard + effectiveGmvPay))}</b></div>
      </div>

      <div className="finSaveRow">
        <button className="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save cost setup"}</button>
        {message && <span className="finMuted">{message}</span>}
      </div>
    </section>
  );
}
