"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Rendered as an actual spreadsheet — lettered columns, numbered rows, a uniform
 * cell grid — because that is the form the seller already reconciles in. Every
 * block (P&L, bundles, settlement breakdown, cost entry) lives on one continuous
 * sheet the way it would in Excel, rather than as separate web cards.
 *
 * Values come from TikTok Shop's own finance model wherever TikTok exposes them.
 */

const COLUMNS = ["A", "B", "C", "D", "E", "F", "G"];
const GROUP_LABELS = { revenue: "Revenue", fee: "Fees & commissions", tax: "Tax", shipping: "Shipping", adjustment: "Adjustments" };
const GROUP_ORDER = ["revenue", "fee", "tax", "shipping", "adjustment"];
const SOURCE_LABEL = { tiktok: "TikTok", manual: "Manual", calc: "Calc" };

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

/** "synced 4m ago" — tick is unused but forces a re-render so the label ages. */
function freshness(lastSynced) {
  if (!lastSynced) return "Never synced";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(lastSynced).getTime()) / 1000));
  if (seconds < 60) return "Synced just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Synced ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  return `Synced ${Math.round(hours / 24)}d ago`;
}

/* ------------------------------------------------------------ cell helpers */

const cell = (value, options = {}) => ({ value, ...options });
const blank = () => cell("");
/** A section heading that spans the sheet, like a merged cell. */
const title = (text) => [cell(text, { className: "xlTitle", span: COLUMNS.length })];
const spacer = () => [];

export function FinanceSheet({ compact = false }) {
  const months = useMemo(monthOptions, []);
  const [period, setPeriod] = useState(months[0].value);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [showCosts, setShowCosts] = useState(false);
  const [live, setLive] = useState(true);
  const [tick, setTick] = useState(0);

  // Cost-entry state lives here so its cells can sit inside the same sheet.
  const [products, setProducts] = useState([]);
  const [periodCost, setPeriodCost] = useState({ period, adsCard: 0, adCredit: 0, whtRate: 0.1, otherCost: 0, adsGmvPayOverride: null, notes: null });
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

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

  // Live mode re-reads stored data every 30s. The webhook and the hourly cron do
  // the actual fetching from TikTok, so this stays cheap — no API quota is spent
  // by leaving the page open.
  //
  // Paused while Cost setup is open: a refresh re-seeds the cost rows from the
  // server, which would discard half-typed unit costs mid-edit.
  useEffect(() => {
    if (!live || showCosts) return undefined;
    const id = setInterval(() => load(false), 30000);
    return () => clearInterval(id);
  }, [live, showCosts, load]);

  // Re-renders the "synced Nm ago" label without refetching.
  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), 20000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!data) return;
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
    const found = (data.periodCosts || []).find((cost) => cost.period === period);
    setPeriodCost(found || { period, adsCard: 0, adCredit: 0, whtRate: 0.1, otherCost: 0, adsGmvPayOverride: null, notes: null });
  }, [data, period]);

  async function saveCosts() {
    setSaving(true);
    setSaveMessage("");
    try {
      const response = await fetch("/api/finance/costs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ products, period: periodCost }),
      });
      const payload = await response.json();
      if (!response.ok) { setSaveMessage(payload.error || "Could not save."); return; }
      setSaveMessage("Saved.");
      load(false);
    } catch (caught) {
      setSaveMessage(caught.message || "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  const updateProduct = (index, patch) => setProducts((rows) => rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));

  /* ------------------------------------------------------- build the sheet */
  const rows = useMemo(() => {
    if (!data) return [];
    const out = [];
    const num = (value, options = {}) => cell(money(value), { className: `xlNum${options.negative ? " xlNeg" : ""}${options.fill ? ` xl${options.fill}` : ""}`, ...options });

    /* ---- summary block ---- */
    out.push(title("SUMMARY"));
    out.push([
      cell("Total Sales", { className: "xlHead" }),
      cell("Duit Masuk", { className: "xlHead" }),
      cell("Nett Profit", { className: "xlHead" }),
      cell("Profit %", { className: "xlHead" }),
      cell("Unit ME", { className: "xlHead" }),
      cell("Orders", { className: "xlHead" }),
      cell("Settled", { className: "xlHead" }),
    ]);
    out.push([
      num(data.totalSales, { fill: "Yellow" }),
      num(data.duitMasuk, { fill: "Yellow" }),
      num(data.nettProfit, { fill: "Yellow", negative: data.nettProfit < 0 }),
      cell(`${(data.profitPercentage * 100).toFixed(2)}%`, { className: "xlNum xlYellow" }),
      cell(data.unitMe.toLocaleString(), { className: "xlNum xlYellow" }),
      cell(data.orderCount.toLocaleString(), { className: "xlNum" }),
      cell(`${data.settledOrders} / ${data.orderCount}`, { className: "xlNum" }),
    ]);
    out.push(spacer());

    /* ---- P&L block ---- */
    out.push(title("PROFIT & LOSS"));
    out.push([
      cell("Item", { className: "xlHead" }),
      cell("Amount", { className: "xlHead" }),
      cell("Source", { className: "xlHead" }),
      cell("Basis", { className: "xlHead", span: 4 }),
    ]);
    const plRow = (label, amount, source, basis, options = {}) => out.push([
      cell(label, { className: `xlLabel${options.strong ? " xlStrong" : ""}` }),
      num(amount, { fill: options.fill, negative: options.negative }),
      cell(SOURCE_LABEL[source], { className: `xlTag xlTag-${source}` }),
      cell(basis, { className: "xlNote", span: 4 }),
    ]);

    plRow("Total Sales (Order Amount)", data.totalSales, "tiktok", `all ${data.orderCount} orders`);
    if (data.pendingSales > 0) plRow("Less: sales not yet settled", -data.pendingSales, "tiktok", `${data.pendingOrders} orders still pending payout`, { negative: true });
    plRow("Settled sales", data.settledSales, "tiktok", `${data.settledOrders} settled orders`, { strong: true });
    plRow("Duit Masuk (Total settlement)", data.duitMasuk, "tiktok", `${(data.settlementRate * 100).toFixed(1)}% of settled sales`, { strong: true, fill: "Yellow" });
    plRow("Kos Produk", -data.kosProdukSettled, "manual", "settled orders only", { negative: true, fill: "Yellow" });
    plRow("Kos Ads By Card", -data.adsCard, "manual", "Ads Manager, whole month", { negative: true });
    plRow("Kos Ads By GMV Pay", data.adsGmvPay, data.adsGmvPayIsOverride ? "manual" : "tiktok", "already inside settlement — not deducted twice");
    plRow("Ad Credit", data.adCredit, "manual", "not netted off profit");
    if (data.otherCost !== 0) plRow("Other cost", -data.otherCost, "manual", "whole month", { negative: true });
    plRow(`WHT ${(data.whtRate * 100).toFixed(0)}% (To Pay)`, -data.wht, "calc", "on card + GMV Pay ad spend", { negative: true, fill: "Yellow" });
    out.push([
      cell("NETT PROFIT", { className: "xlTotalLabel" }),
      cell(money(data.nettProfit), { className: `xlTotal xlNum${data.nettProfit < 0 ? " xlNeg" : ""}` }),
      cell(`${(data.profitPercentage * 100).toFixed(2)}%`, { className: "xlTotal xlNum" }),
      cell("of settled sales · margin on money received " + `${(data.marginOnSettlement * 100).toFixed(2)}%`, { className: "xlTotal", span: 4 }),
    ]);
    out.push(spacer());

    /* ---- bundles block ---- */
    out.push(title("QUANTITY BY BUNDLE"));
    out.push([
      cell("Bundle", { className: "xlHead" }),
      cell("Qty", { className: "xlHead" }),
      cell("Unit Cost", { className: "xlHead" }),
      cell("Bottles", { className: "xlHead" }),
      cell("Kos Produk", { className: "xlHead" }),
      cell("", { className: "xlHead", span: 2 }),
    ]);
    if (!data.bundles.length) out.push([cell("No orders in this month yet.", { className: "xlNote", span: COLUMNS.length })]);
    for (const bundle of data.bundles) {
      out.push([
        cell(bundle.bundle, { className: `xlLabel${bundle.matched ? "" : " xlUnmapped"}` }),
        cell(bundle.quantity.toLocaleString(), { className: "xlNum" }),
        cell(bundle.matched ? money(bundle.unitCost) : "—", { className: "xlNum" }),
        cell(bundle.matched ? (bundle.bottles * bundle.quantity).toLocaleString() : "—", { className: "xlNum" }),
        cell(bundle.matched ? money(bundle.totalCost) : "—", { className: "xlNum" }),
        cell(bundle.matched ? "" : "no cost mapped", { className: "xlNote xlWarnCell", span: 2 }),
      ]);
    }
    out.push([
      cell("TOTAL", { className: "xlTotalLabel" }),
      cell(data.totalQuantity.toLocaleString(), { className: "xlTotal xlNum" }),
      cell("", { className: "xlTotal" }),
      cell(data.unitMe.toLocaleString(), { className: "xlTotal xlNum" }),
      cell(money(data.kosProduk), { className: "xlTotal xlNum" }),
      cell("", { className: "xlTotal", span: 2 }),
    ]);
    out.push(spacer());

    /* ---- settlement breakdown block ---- */
    out.push(title("TIKTOK SHOP SETTLEMENT BREAKDOWN"));
    if (!data.lines.length) {
      out.push([cell("No settlement data for this month yet. Payouts appear after TikTok closes the statement.", { className: "xlNote", span: COLUMNS.length })]);
    } else {
      out.push([
        cell("Line", { className: "xlHead", span: 3 }),
        cell("Amount", { className: "xlHead" }),
        cell("Share of revenue", { className: "xlHead", span: 3 }),
      ]);
      const base = Math.abs(data.revenueAmount) || Math.abs(data.settledSales) || 1;
      for (const group of GROUP_ORDER) {
        const lines = data.lines.filter((line) => line.group === group);
        if (!lines.length) continue;
        const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
        out.push([
          cell(GROUP_LABELS[group], { className: "xlGroup", span: 3 }),
          cell(money(subtotal), { className: "xlGroup xlNum" }),
          cell("", { className: "xlGroup", span: 3 }),
        ]);
        for (const line of lines) {
          const share = Math.min(100, (Math.abs(line.amount) / base) * 100);
          out.push([
            cell(line.label, { className: "xlLabel xlIndent", span: 3, title: line.key }),
            cell(money(line.amount), { className: `xlNum${line.amount < 0 ? " xlNeg" : ""}` }),
            cell(
              <span className="xlBar"><i className={line.amount < 0 ? "down" : "up"} style={{ width: `${share.toFixed(1)}%` }} /><em>{share.toFixed(1)}%</em></span>,
              { className: "xlBarCell", span: 3 },
            ),
          ]);
        }
      }
      out.push([
        cell("DUIT MASUK (TOTAL SETTLEMENT)", { className: "xlTotalLabel", span: 3 }),
        cell(money(data.duitMasuk), { className: "xlTotal xlNum" }),
        cell("", { className: "xlTotal", span: 3 }),
      ]);
      if (data.reserveAmount !== 0) {
        out.push([
          cell("Held in reserve (not yet paid out)", { className: "xlLabel", span: 3 }),
          cell(money(data.reserveAmount), { className: "xlNum" }),
          cell("", { span: 3 }),
        ]);
      }
    }

    return out;
  }, [data, money]);

  const settledPercent = data && data.orderCount > 0 ? (data.settledOrders / data.orderCount) * 100 : 0;

  return (
    <main className={compact ? "finPane" : "finShell"}>
      <header className={compact ? "finHeaderCompact" : "finHeader"}>
        {compact ? (
          <b className="finPaneTitle">Financial dashboard</b>
        ) : (
          <div>
            <p className="eyebrow">TIKTOK SHOP · {data?.currency || "MYR"}</p>
            <h1>Financial dashboard</h1>
          </div>
        )}
        <div className="finControls">
          <select value={period} onChange={(event) => setPeriod(event.target.value)} aria-label="Month">
            {months.map((month) => <option key={month.value} value={month.value}>{month.label}</option>)}
          </select>
          <button className="finGhost" onClick={() => setShowCosts((open) => !open)}>{showCosts ? "Hide cost setup" : "Cost setup"}</button>
          <button className={`finLive${live ? " on" : ""}`} onClick={() => setLive((value) => !value)} title="Re-read every 30s">
            <i />{live ? "Live" : "Paused"}
          </button>
          <button
            className="finGhost"
            onClick={() => load(true)}
            disabled={syncing}
            title="Not required — the hourly job keeps this current. Use this for a deep 90-day backfill or to refresh immediately."
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          {!compact && <a className="finBack" href="/">Back</a>}
        </div>
      </header>

      {data && <p className="finFresh">{freshness(data.lastSynced, tick)}{!live ? " · live paused" : showCosts ? " · live paused while editing costs" : " · auto-syncs hourly, page re-reads every 30s"}</p>}
      {error && <p className="finError">{error}</p>}
      {data?.sync?.errors?.length > 0 && data.sync.errors.map((message) => <p key={message} className="finWarn">{message}</p>)}
      {data?.sync && !data.sync.errors.length && (
        <p className="finOk">
          Synced {data.sync.orders} orders and {data.sync.settlements} settlement transactions from {data.sync.statements} payout statements
          {data.sync.statementsSkipped ? ` (${data.sync.statementsSkipped} already stored)` : ""}
          {data.sync.sellerName ? ` · ${data.sync.sellerName}` : ""}.
        </p>
      )}
      {data?.lineDrift?.length > 0 && (
        <p className="finWarn">
          A breakdown subtotal does not match the total TikTok reports for it
          ({data.lineDrift.map((entry) => `${entry.group} off by ${money(entry.drift)}`).join(", ")}).
          Re-sync with <code>&amp;refresh=1</code>; until then trust Duit Masuk over the breakdown.
        </p>
      )}
      {data?.pendingOrders > 0 && (
        <p className="finWarn">
          <b>This month is still paying out.</b> {data.settledOrders} of {data.orderCount} orders have settled ({settledPercent.toFixed(0)}%),
          leaving {money(data.pendingSales)} of sales pending. The P&amp;L covers settled orders only, so it is a true margin on money received — not the month&apos;s final result.
        </p>
      )}
      {data?.unmappedSkus?.length > 0 && (
        <p className="finWarn">
          {data.unmappedSkus.length} SKU{data.unmappedSkus.length === 1 ? " has" : "s have"} no product cost mapped
          ({data.unmappedSkus.slice(0, 3).map((sku) => sku.skuKey).join(", ")}{data.unmappedSkus.length > 3 ? "…" : ""}).
          Kos Produk reads low and profit reads high until you map {data.unmappedSkus.length === 1 ? "it" : "them"} in Cost setup.
        </p>
      )}

      {loading && !data && <p className="finMuted">Loading…</p>}

      {data && (
        <>
        {showCosts && (
          <section className="costPanel">
            <div className="costPanelHead">
              <div>
                <h2>Cost setup</h2>
                <p>The only numbers TikTok Shop cannot supply: what each bundle costs to make, and ad spend billed to a card in Ads Manager.</p>
              </div>
              <div className="costPanelActions">
                <button className="primary" onClick={saveCosts} disabled={saving}>{saving ? "Saving…" : "Save cost setup"}</button>
                {saveMessage && <span className="finMuted">{saveMessage}</span>}
                <button className="costClose" onClick={() => setShowCosts(false)} title="Close">✕</button>
              </div>
            </div>

            <div className="costScroll">
              <table className="costTable">
                <thead>
                  <tr><th>SKU</th><th>TikTok name</th><th>Bundle name</th><th>Unit cost</th><th>Bottles</th><th>Sold</th></tr>
                </thead>
                <tbody>
                  {products.length === 0 && <tr><td colSpan={6} className="costEmpty">No SKUs yet — hit Sync now first.</td></tr>}
                  {products.map((product, index) => (
                    <tr key={product.skuKey}>
                      <th><code>{product.skuKey}</code></th>
                      <td className="costName">{product.label}</td>
                      <td><input value={product.bundle} onChange={(event) => updateProduct(index, { bundle: event.target.value })} /></td>
                      <td><input type="number" step="0.01" value={product.unitCost} onChange={(event) => updateProduct(index, { unitCost: Number(event.target.value) })} /></td>
                      <td><input type="number" step="1" value={product.bottles} onChange={(event) => updateProduct(index, { bottles: Number(event.target.value) })} /></td>
                      <td className="costSold">{product.quantity.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="costSubhead">Ad spend &amp; tax — {period}</h3>
            <p className="finMuted costNote">GMV Pay syncs from TikTok&apos;s GMV Max ad fee. Card-billed spend and ad credits live in TikTok Ads Manager, which a TikTok Shop authorization cannot reach.</p>
            <div className="costFields">
              <label>Kos Ads By Card<input type="number" step="0.01" value={periodCost.adsCard} onChange={(event) => setPeriodCost({ ...periodCost, adsCard: Number(event.target.value) })} /></label>
              <div className="costField">
                <div className="costFieldHead">
                  <span>Kos Ads By GMV Pay</span>
                  <button className="finLink" onClick={() => setPeriodCost({ ...periodCost, adsGmvPayOverride: periodCost.adsGmvPayOverride === null ? Number((data.adsGmvPayIsOverride ? 0 : data.adsGmvPay).toFixed(2)) : null })}>
                    {periodCost.adsGmvPayOverride === null ? "Override" : "Use synced"}
                  </button>
                </div>
                {periodCost.adsGmvPayOverride === null
                  ? <><b>{money(data.adsGmvPayIsOverride ? 0 : data.adsGmvPay)}</b><small className="finFromTikTok">Synced from TikTok</small></>
                  : <input type="number" step="0.01" value={periodCost.adsGmvPayOverride} onChange={(event) => setPeriodCost({ ...periodCost, adsGmvPayOverride: Number(event.target.value) })} />}
              </div>
              <label>Ad Credit<input type="number" step="0.01" value={periodCost.adCredit} onChange={(event) => setPeriodCost({ ...periodCost, adCredit: Number(event.target.value) })} /></label>
              <label>Other cost<input type="number" step="0.01" value={periodCost.otherCost} onChange={(event) => setPeriodCost({ ...periodCost, otherCost: Number(event.target.value) })} /></label>
              <label>WHT rate (%)<input type="number" step="0.1" value={(periodCost.whtRate * 100).toFixed(1)} onChange={(event) => setPeriodCost({ ...periodCost, whtRate: Number(event.target.value) / 100 })} /></label>
              <div className="costField"><span>WHT to pay</span><b>{money(periodCost.whtRate * (periodCost.adsCard + (periodCost.adsGmvPayOverride ?? (data.adsGmvPayIsOverride ? 0 : data.adsGmvPay))))}</b></div>
            </div>
          </section>
        )}

        <div className="xlFrame">
          <div className="xlScroll">
            <table className="xl">
              <thead>
                <tr>
                  <th className="xlCorner" />
                  {COLUMNS.map((column) => <th key={column} className="xlColHead">{column}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((cells, rowIndex) => (
                  <tr key={rowIndex} className={cells.length === 0 ? "xlSpacer" : undefined}>
                    <th className="xlRowNum">{rowIndex + 1}</th>
                    <SheetRow cells={cells} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="xlTabs"><span className="xlTab on">{period}</span><span className="xlTabHint">Values marked TikTok are measured; Manual are entered by you.</span></div>
        </div>
        </>
      )}
    </main>
  );
}

/** Emits a row's cells and pads the remainder so the grid never has ragged edges. */
function SheetRow({ cells }) {
  const used = cells.reduce((total, item) => total + (item.span || 1), 0);
  const padding = Math.max(0, COLUMNS.length - used);
  return (
    <>
      {cells.map((item, index) => (
        <td key={index} className={item.className} colSpan={item.span || 1} title={item.title}>{item.value}</td>
      ))}
      {Array.from({ length: padding }, (_, index) => <td key={`pad-${index}`} />)}
    </>
  );
}
