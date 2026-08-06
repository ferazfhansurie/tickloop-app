"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// The seller's spreadsheet defines which variables must appear; the values come
// from TikTok Shop's own finance model wherever TikTok exposes them, so this
// reconciles against Seller Center instead of approximating it.

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
  return {
    from: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    to: new Date(Date.UTC(year, month, 1)).toISOString(),
  };
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

  return (
    <main className="finShell">
      <header className="finHeader">
        <div>
          <p className="eyebrow">TIKTOK SHOP</p>
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
          {data.sync.sellerName ? ` · ${data.sync.sellerName}` : ""}.
        </p>
      )}

      {loading && !data && <p className="finMuted">Loading…</p>}

      {data && (
        <>
          <section className="finStats">
            <article><span>Total Sales (Order Amount)</span><b>{money(data.totalSales)}</b><small>{data.orderCount} orders counted</small></article>
            <article><span>Duit Masuk (Total settlement)</span><b>{money(data.duitMasuk)}</b><small>{data.settledOrders} of {data.orderCount} settled</small></article>
            <article className={data.nettProfit < 0 ? "finNegative" : "finPositive"}><span>Nett Profit</span><b>{money(data.nettProfit)}</b><small>{(data.profitPercentage * 100).toFixed(2)}% of sales</small></article>
            <article><span>Unit ME</span><b>{data.unitMe.toLocaleString()}</b><small>{data.totalQuantity.toLocaleString()} units sold</small></article>
          </section>

          {data.unsettledOrders > 0 && (
            <p className="finWarn">
              {data.unsettledOrders} of {data.orderCount} orders have not settled yet. TikTok pays out after the return window, so Duit Masuk and Nett Profit will rise as they clear.
            </p>
          )}
          {data.unmappedSkus.length > 0 && (
            <p className="finWarn">
              {data.unmappedSkus.length} SKU{data.unmappedSkus.length === 1 ? " has" : "s have"} no product cost mapped
              ({data.unmappedSkus.slice(0, 3).map((sku) => sku.skuKey).join(", ")}{data.unmappedSkus.length > 3 ? "…" : ""}).
              Kos Produk is understated and profit is overstated until you map {data.unmappedSkus.length === 1 ? "it" : "them"} in Cost setup.
            </p>
          )}

          {showCosts && <CostSetup data={data} money={money} period={period} onSaved={() => load(false)} />}

          <div className="finGrid">
            <section className="finCard">
              <div className="finCardHead">
                <h2>Profit &amp; loss</h2>
                <p>Where each number comes from is marked, so you always know what is measured and what is typed.</p>
              </div>
              <dl className="finPL">
                <PLRow label="Total Sales (Order Amount)" value={money(data.totalSales)} source="tiktok" />
                {data.customerPayment > 0 && Math.abs(data.customerPayment - data.totalSales) > 0.01 && (
                  <PLRow label="Customer payment (settled)" value={money(data.customerPayment)} source="tiktok" note="TikTok's finance view, net of refunds" />
                )}
                <PLRow label="Duit Masuk (Total settlement)" value={money(data.duitMasuk)} source="tiktok" />
                <PLRow label="Kos Produk" value={money(data.kosProduk)} source="manual" negative />
                <PLRow label="Kos Ads By Card" value={money(data.adsCard)} source="manual" negative />
                <PLRow
                  label="Kos Ads By GMV Pay"
                  value={money(data.adsGmvPay)}
                  source={data.adsGmvPayIsOverride ? "manual" : "tiktok"}
                  note={data.adsGmvPayIsOverride ? "manual override — already inside settlement" : "GMV Max ad fee — already inside settlement"}
                />
                <PLRow label="Ad Credit" value={money(data.adCredit)} source="manual" note="not netted off profit" />
                {data.otherCost !== 0 && <PLRow label="Other cost" value={money(data.otherCost)} source="manual" negative />}
                <PLRow label={`WHT ${(data.whtRate * 100).toFixed(0)}% (To Pay)`} value={money(data.wht)} source="calc" negative />
              </dl>
              <div className="finTotal">
                <div><span>Nett Profit</span><b>{money(data.nettProfit)}</b></div>
                <div><span>Profit Percentage</span><b>{(data.profitPercentage * 100).toFixed(2)}%</b></div>
                <div><span>Margin on money received</span><b>{(data.marginOnSettlement * 100).toFixed(2)}%</b></div>
              </div>
              <p className="finFootnote">
                Nett Profit = Duit Masuk − Kos Produk − Kos Ads By Card − WHT{data.otherCost !== 0 ? " − Other cost" : ""}.
                GMV Pay is <b>not</b> subtracted again: TikTok charges it as a fee inside the settlement, so it is already absent from Duit Masuk. It still drives WHT, which you pay separately.
              </p>
            </section>

            <section className="finCard">
              <div className="finCardHead">
                <h2>Quantity by bundle</h2>
                <p>Unit ME counts bottles, so trial sachets set to 0 bottles never inflate it.</p>
              </div>
              <div className="tableWrap">
                <table className="finTable">
                  <thead><tr><th>Bundle</th><th>Qty</th><th>Unit cost</th><th>Bottles</th><th>Kos Produk</th></tr></thead>
                  <tbody>
                    {data.bundles.length === 0 && <tr><td colSpan={5} className="finMuted">No orders in this month yet.</td></tr>}
                    {data.bundles.map((bundle) => (
                      <tr key={bundle.bundle} className={bundle.matched ? "" : "finUnmapped"}>
                        <td><strong>{bundle.bundle}</strong>{!bundle.matched && <small>no cost mapped</small>}</td>
                        <td>{bundle.quantity.toLocaleString()}</td>
                        <td>{bundle.matched ? money(bundle.unitCost) : "—"}</td>
                        <td>{bundle.matched ? bundle.bottles * bundle.quantity : "—"}</td>
                        <td>{bundle.matched ? money(bundle.totalCost) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><th>Total</th><th>{data.totalQuantity.toLocaleString()}</th><th /><th>{data.unitMe.toLocaleString()}</th><th>{money(data.kosProduk)}</th></tr>
                  </tfoot>
                </table>
              </div>
            </section>
          </div>

          <SettlementBreakdown data={data} money={money} />
        </>
      )}
    </main>
  );
}

const SOURCE_LABEL = { tiktok: "TikTok", manual: "Manual", calc: "Calculated" };

function PLRow({ label, value, source, negative, note }) {
  return (
    <div className="finPLRow">
      <dt>
        {label}
        <span className={`finTag ${source}`}>{SOURCE_LABEL[source]}</span>
        {note && <small>{note}</small>}
      </dt>
      <dd className={negative ? "finDeduct" : ""}>{negative ? `− ${value}` : value}</dd>
    </div>
  );
}

/**
 * TikTok's own settlement arithmetic, line by line. This is the part a spreadsheet
 * can only show as one lump: it makes visible whether margin is going to
 * commission, affiliate payouts, GMV Max ads or shipping.
 */
function SettlementBreakdown({ data, money }) {
  const base = Math.abs(data.revenueAmount) || Math.abs(data.totalSales) || 1;

  return (
    <section className="finCard">
      <div className="finCardHead finCardHeadRow">
        <div>
          <h2>TikTok Shop settlement breakdown</h2>
          <p>Every fee TikTok took, exactly as it reports them. Deductions shown negative.</p>
        </div>
        <span className="finMuted">{data.settledOrders} settled orders · {data.settledTransactions} transactions</span>
      </div>

      {data.lines.length === 0 ? (
        <p className="finMuted finPad">No settlement data for this month yet. Payouts appear after TikTok closes the statement, so hit Sync TikTok once orders have settled.</p>
      ) : (
        <>
          {data.lineDrift?.length > 0 && (
            <p className="finWarn finPad">
              A breakdown subtotal does not match the total TikTok reports for it
              ({data.lineDrift.map((entry) => `${entry.group} off by ${money(entry.drift)}`).join(", ")}).
              A line is being double-counted or missed — trust Duit Masuk over the breakdown until this is fixed.
            </p>
          )}
          {Math.abs(data.settlementDrift) > 0.05 && (
            <p className="finWarn finPad">
              Revenue + fees + shipping + adjustments is off from the reported settlement by {money(data.settlementDrift)}. TikTok may be sending a component this dashboard does not read yet — treat the breakdown as indicative and Duit Masuk as authoritative.
            </p>
          )}
          {GROUP_ORDER.map((group) => {
            const lines = data.lines.filter((line) => line.group === group);
            if (!lines.length) return null;
            const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
            return (
              <div key={group} className="finGroup">
                <div className="finGroupHead"><h3>{GROUP_LABELS[group]}</h3><b>{money(subtotal)}</b></div>
                {lines.map((line) => {
                  const share = Math.min(100, (Math.abs(line.amount) / base) * 100);
                  return (
                    <div key={`${line.group}:${line.key}`} className="finLine">
                      <span className="finLineLabel" title={line.key}>{line.label}</span>
                      <span className="finBar"><i className={line.amount < 0 ? "down" : "up"} style={{ width: `${share.toFixed(1)}%` }} /></span>
                      <span className="finShare">{share.toFixed(1)}%</span>
                      <span className={`finAmount${line.amount < 0 ? " finDeduct" : ""}`}>{money(line.amount)}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div className="finSettleTotal"><span>Duit Masuk (Total settlement)</span><b>{money(data.duitMasuk)}</b></div>
          {data.reserveAmount !== 0 && (
            <div className="finReserve"><span>Held in reserve (not yet paid out)</span><b>{money(data.reserveAmount)}</b></div>
          )}
        </>
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
        bundle: found?.bundle || sku.skuName || sku.productName || sku.skuKey,
        unitCost: found?.unitCost ?? 0,
        bottles: found?.bottles ?? 0,
        sortOrder: found?.sortOrder ?? index,
        quantity: sku.quantity,
      };
    });
    // Keep mapped SKUs that no longer appear in the synced window.
    for (const cost of data.productCosts || []) {
      if (!rows.some((row) => row.skuKey === cost.skuKey)) rows.push({ ...cost, quantity: 0 });
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
    <section className="finCard finCostSetup">
      <div className="finCardHead">
        <h2>Cost setup</h2>
        <p>The only numbers TikTok Shop cannot tell us: what each bundle costs to make, and ad spend billed to a card in Ads Manager.</p>
      </div>

      <div className="finGroup">
        <h3>Product cost per SKU</h3>
        <p className="finMuted">Bottles drives Unit ME — set trial sachets to 0 so they never inflate the bottle count.</p>
        <div className="tableWrap">
          <table className="finTable">
            <thead><tr><th>SKU</th><th>Bundle name</th><th>Unit cost</th><th>Bottles</th><th>Sold</th></tr></thead>
            <tbody>
              {products.length === 0 && <tr><td colSpan={5} className="finMuted">No SKUs yet — hit Sync TikTok first.</td></tr>}
              {products.map((product, index) => (
                <tr key={product.skuKey}>
                  <td><code>{product.skuKey}</code></td>
                  <td><input value={product.bundle} onChange={(event) => update(index, { bundle: event.target.value })} /></td>
                  <td><input type="number" step="0.01" value={product.unitCost} onChange={(event) => update(index, { unitCost: Number(event.target.value) })} /></td>
                  <td><input type="number" step="1" value={product.bottles} onChange={(event) => update(index, { bottles: Number(event.target.value) })} /></td>
                  <td>{product.quantity.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="finGroup">
        <h3>Ad spend &amp; tax — {period}</h3>
        <p className="finMuted">GMV Pay syncs from TikTok&apos;s GMV Max ad fee. Card-billed spend and ad credits live in TikTok Ads Manager, which a TikTok Shop authorization cannot reach.</p>
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
      </div>

      <div className="finSaveRow">
        <button className="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save cost setup"}</button>
        {message && <span className="finMuted">{message}</span>}
      </div>
    </section>
  );
}
