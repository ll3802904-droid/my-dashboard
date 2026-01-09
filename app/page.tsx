"use client";

import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

/**
 * eBay Excel Dashboard (Upgraded single-file version)
 * - Reducer-driven filter/sort/paging state
 * - Internal component split (FilterPanel / KPI / Report / Charts / Table / Costs)
 * - Non-blocking toast notifications (replaces alert)
 * - File parsing loading feedback
 * - Export CSV / Export Excel (current filtered list)
 *
 * Drop-in replacement for your current page.tsx.
 */

type RawRow = Record<string, any>;

type Row = {
  sku: string;
  name: string; // 商品标题
  category: string;
  payoutStatus: string;

  soldQty: number;
  gmvUsd: number;
  payoutCny: number;

  paidAt: Date | null; // eBay用户付款时间
  payoutAt: Date | null; // 回款时间

  titleGroup: string; // 标题分类
};

type TabKey = "overview" | "orders" | "costs";
type OverviewView =
  | "top10-gmv"
  | "top10-payout"
  | "top10-profit"
  | "trend-gmv"
  | "trend-payout"
  | "trend-profit"
  | "other";

type SortKey = "profit" | "payout" | "gmv" | "lot";
type SortDir = "desc" | "asc";

type TopItem = { group: string; value: number };
type DailyPoint = { date: string; value: number };

type ReportPayload = {
  summary: string;
  statusLine: string;
  highlights: string[];
  risks: string[];
  actions: string[];
  note: string;
  copyText: string;
};

/** ========== 默认成本（每 1 lot 成本，人民币） ========== */
const COST_DEFAULTS: Record<string, number> = {
  "AR/CHR": 2,
  "Ball Holo": 0.2,
  Japanese: 0.5,
  "KFC Pack": 3,
  "Logo Reverse Holo": 1,
  "Master Ball": 0.7,
  Mix: 0.2,
  OCD: 14,
  "RR Only": 0.4,
  "RR+RRR": 0.6,
  "RRR+VMAX": 0.7,
  "SR/HR": 3,
  Sealed: 0,
  "TAG TEAM": 0,
  "Trainer Item / Supporter": 0,
  "V/VMAX/VSTAR": 0,
  "VSTAR Universe": 0,
  "VSTAR Universe (Sealed)": 0,
  "VSTAR Universe (Singles)": 0,
  "VSTAR Universe (Lots)": 0,
  "VSTAR Universe (Master Ball)": 0.7,
  "VSTAR Universe (AR/CHR)": 2,
  "VSTAR Universe (SR/HR)": 3,
  Other: 0,
};

const LS_COST_MAP_KEY = "costMap_v2";
const LS_ROW_OVERRIDE_KEY = "rowCostOverride_v2";

/** ========== hash + 稳定行 ID ========== */
function hashStr(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function rowId(r: Row) {
  // 选“相对稳定”的字段：SKU+标题+付款时间+回款时间
  // 这样你重新导入同一个 Excel，大概率能对上之前的覆盖
  return hashStr(
    [r.sku || "", r.name || "", r.paidAt ? r.paidAt.toISOString() : "", r.payoutAt ? r.payoutAt.toISOString() : ""].join("|")
  );
}

/** ========== 标题分类 ========== */

function classifyTitleGroup(title: string) {
  const t = (title || "").replace(/\s+/g, " ").trim();

  // 关键词类（优先级最高）
  const hasKfcPack = /\bkfc\b/i.test(t) && /\bpack(s)?\b/i.test(t); // KFC + pack/packs
  const hasOcd = /\bocd\b/i.test(t);
  const hasTagTeam = /\btag\s*team\b/i.test(t);
  const hasSealed = /\bsealed\b/i.test(t);

  const hasMasterBall = /\bmaster\s*ball\b/i.test(t);
  const hasLogoReverseHolo = /\blogo\s*reverse\s*holo\b/i.test(t);
  const hasBallHolo = /\bball\s*holo\b/i.test(t); // 注意：Master Ball Holo 也会匹配这里，但因为 Master Ball 在前面，所以不会被抢
  const hasMix = /\bmix\b/i.test(t);

  const hasAR = /\bAR\b/i.test(t);
  const hasCHR = /\bCHR\b/i.test(t);

  const hasSR = /\bSR\b/i.test(t);
  const hasHR = /\bHR\b/i.test(t);

  // 稀有度/形态类（“只包含xx”的那几类）
  const hasRRR = /\bRRR\b/i.test(t);
  const hasRR = /\bRR\b/i.test(t); // 不会误伤 RRR（因为 RRR 中间没有词边界）
  const hasVMAX = /\bVMAX\b/i.test(t);

  // 其他稀有度（出现就排除“只包含RR/只包含RR+RRR/只包含RRR+VMAX”）
  const hasOtherRarity =
    /\bRRRR\b/i.test(t) ||
    /\bUR\b/i.test(t) ||
    /\bSSR\b/i.test(t) ||
    hasSR ||
    hasHR ||
    hasAR ||
    hasCHR ||
    hasTagTeam; // TAG TEAM 单独一类

  // 语言类（出现 Japanese 就直接归 Japanese）
  const isJapanese = /\bjapanese\b/i.test(t);

  // ——优先级命中——
  if (hasKfcPack) return "KFC Pack";
  if (hasOcd) return "OCD";
  if (hasTagTeam) return "TAG TEAM";
  if (hasSealed) return "Sealed";
  if (hasMasterBall) return "Master Ball"; // ✅ Master Ball 优先于 Ball Holo
  if (hasLogoReverseHolo) return "Logo Reverse Holo";
  if (hasBallHolo) return "Ball Holo";
  if (hasMix) return "Mix";
  if (hasAR || hasCHR) return "AR/CHR";
  if ((hasSR || hasHR) && !hasOcd) return "SR/HR"; // ✅ SR/HR 不要有 OCD
  if (isJapanese) return "Japanese";

  // ——“只包含xx”类别（放在最后，避免抢走更具体的类）——

  // 只包含 RRR + VMAX（不能带 RR、不能带 SR/AR/CHR/HR/TAG TEAM 等）
  if (hasRRR && hasVMAX && !hasRR && !hasOtherRarity) return "RRR+VMAX Only";

  // 只包含 RR + RRR（不能带 VMAX，也不能带其它稀有度）
  if (hasRR && hasRRR && !hasVMAX && !hasOtherRarity) return "RR+RRR Only";

  // 只包含 RR（不能带 RRR/VMAX，也不能带其它稀有度）
  if (hasRR && !hasRRR && !hasVMAX && !hasOtherRarity) return "RR Only";

  // 只包含 RRR（可选但常用）
  if (hasRRR && !hasRR && !hasVMAX && !hasOtherRarity) return "RRR Only";

  // 只包含 VMAX（可选但常用）
  if (hasVMAX && !hasRR && !hasRRR && !hasOtherRarity) return "VMAX Only";

  return "Other";
}


function parseLotCountFromTitle(title: string): number {
  const t = (title || "").replace(/\s+/g, " ").trim();

  let m = t.match(/\b(\d+(?:\.\d{1,2})?)\s*lot\b/i);
  if (!m) m = t.match(/\blot\s*(\d+(?:\.\d{1,2})?)\b/i);
  if (!m) return 1;

  const raw = m[1];
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;

  // 你例子里出现过 1.50 Lot，容错为 150
  if (raw.includes(".") && n < 10) {
    const scaled = Math.round(n * 100);
    if (scaled >= 10 && scaled <= 5000) return scaled;
  }
  return Math.round(n);
}

/** ========== Excel 表头匹配 + 数值/日期解析 ========== */
function normHeader(h: string) {
  return String(h ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[()（）]/g, "")
    .replace(/\$/g, "USD")
    .replace(/¥/g, "CNY");
}

function pickKey(r: RawRow, candidates: string[]) {
  const keys = Object.keys(r);
  const normKeys = new Map<string, string>();
  keys.forEach((k) => normKeys.set(normHeader(k), k));

  for (const c of candidates) {
    const k = normKeys.get(normHeader(c));
    if (k) return k;
  }
  return "";
}

function toNumber(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim().replace(/,/g, "");
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function excelDateToJSDate(v: any): Date | null {
  if (!v && v !== 0) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return new Date(d.y, d.m - 1, d.d, d.H, d.M, d.S);
  }
  const s = String(v).trim();
  if (!s) return null;
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** ========== 日期工具（按天聚合） ========== */
function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function dayKey(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function parseYmd(ymd: string): Date | null {
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
function endOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function filterByDate(input: Row[], getDt: (r: Row) => Date | null, startYmd: string, endYmd: string) {
  const start = parseYmd(startYmd);
  const end = endYmd ? endOfDay(parseYmd(endYmd)!) : null;
  if (!start && !end) return input;

  return input.filter((r) => {
    const dt = getDt(r);
    if (!dt) return false;
    if (start && dt < start) return false;
    if (end && dt > end) return false;
    return true;
  });
}

function buildDailySeries(
  input: Row[],
  getDt: (r: Row) => Date | null,
  getVal: (r: Row) => number,
  startYmd: string,
  endYmd: string
): DailyPoint[] {
  if (!input.length) return [];

  let minD: Date | null = null;
  let maxD: Date | null = null;

  input.forEach((r) => {
    const dt = getDt(r);
    if (!dt) return;
    const d0 = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    if (!minD || d0 < minD) minD = d0;
    if (!maxD || d0 > maxD) maxD = d0;
  });

  const start = startYmd ? parseYmd(startYmd)! : minD;
  const end = endYmd ? parseYmd(endYmd)! : maxD;
  if (!start || !end) return [];

  const map = new Map<string, number>();
  input.forEach((r) => {
    const dt = getDt(r);
    if (!dt) return;
    const key = dayKey(dt);
    map.set(key, (map.get(key) ?? 0) + (getVal(r) || 0));
  });

  const out: DailyPoint[] = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const key = dayKey(d);
    out.push({ date: key, value: Number(((map.get(key) ?? 0) as number).toFixed(2)) });
  }
  return out;
}

/** ========== 数值工具 ========== */
function money(n: number, digits = 2) {
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
function median(arr: number[]) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  if (a.length % 2 === 0) return (a[mid - 1] + a[mid]) / 2;
  return a[mid];
}
function percentile(arr: number[], p: number) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.floor((a.length - 1) * p)));
  return a[idx];
}

/** ========== 通用 Hook：localStorage 状态 ========== */
function useLocalStorageState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const loadedRef = useRef(false);

  useEffect(() => {
    // 只在客户端读取
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
      if (raw) {
        setValue(JSON.parse(raw) as T);
      }
    } catch {
      // ignore
    } finally {
      loadedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!loadedRef.current) return;
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore
    }
  }, [key, value]);

  return [value, setValue] as const;
}

/** ========== Toast ========== */
type ToastType = "success" | "error" | "info";
type ToastItem = { id: string; type: ToastType; message: string };

function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const push = (type: ToastType, message: string) => {
    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3200);
  };

  const remove = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id));

  return { toasts, push, remove };
}

function ToastStack({ toasts, onClose }: { toasts: ToastItem[]; onClose: (id: string) => void }) {
  if (!toasts.length) return null;
  return (
    <div style={{ position: "fixed", right: 16, top: 16, zIndex: 9999, display: "grid", gap: 10, width: 360, maxWidth: "calc(100vw - 32px)" }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            borderRadius: 14,
            border: "1px solid #e2e8f0",
            background: "#fff",
            padding: 12,
            boxShadow: "0 10px 25px rgba(0,0,0,0.08)",
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: 99,
                background:
                  t.type === "success" ? "#16a34a" : t.type === "error" ? "#dc2626" : "#2563eb",
              }}
            />
            <div style={{ fontWeight: 800, color: "#0f172a" }}>
              {t.type === "success" ? "成功" : t.type === "error" ? "出错" : "提示"}
            </div>
            <div style={{ flex: 1 }} />
            <button onClick={() => onClose(t.id)} style={btnGhostSm()}>
              ✕
            </button>
          </div>
          <div style={{ color: "#334155", lineHeight: 1.4, fontSize: 13 }}>{t.message}</div>
        </div>
      ))}
    </div>
  );
}

/** ========== Styling helpers (still inline, but centralized) ========== */
function smallStyle(): React.CSSProperties {
  return { color: "#64748b", fontSize: 12 };
}
function card(): React.CSSProperties {
  return { border: "1px solid #e2e8f0", borderRadius: 14, background: "#fff" };
}
function cardPad(): React.CSSProperties {
  return { padding: 14 };
}
function pill(active = false): React.CSSProperties {
  return {
    padding: "8px 12px",
    borderRadius: 999,
    border: active ? "1px solid #0f172a" : "1px solid #e2e8f0",
    background: active ? "#0f172a" : "#fff",
    color: active ? "#fff" : "#0f172a",
    cursor: "pointer",
    fontWeight: 800,
    fontSize: 12,
  };
}
function inputBase(): React.CSSProperties {
  return {
    width: "100%",
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #e2e8f0",
    outline: "none",
    fontSize: 13,
  };
}
function btnGhostSm(): React.CSSProperties {
  return {
    border: "1px solid #e2e8f0",
    background: "#fff",
    borderRadius: 10,
    padding: "6px 10px",
    cursor: "pointer",
    fontWeight: 800,
    fontSize: 12,
    color: "#0f172a",
  };
}
function btnPrimarySm(): React.CSSProperties {
  return {
    border: "1px solid #0f172a",
    background: "#0f172a",
    borderRadius: 10,
    padding: "6px 10px",
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 12,
    color: "#fff",
  };
}

/** ========== Filters reducer ========== */
type FiltersState = {
  status: string;
  category: string;
  group: string;
  q: string;

  paidStartYmd: string;
  paidEndYmd: string;
  payoutStartYmd: string;
  payoutEndYmd: string;

  sortKey: SortKey;
  sortDir: SortDir;
  page: number;
  pageSize: number;
};

const initialFilters: FiltersState = {
  status: "全部",
  category: "全部",
  group: "全部",
  q: "",
  paidStartYmd: "",
  paidEndYmd: "",
  payoutStartYmd: "",
  payoutEndYmd: "",
  sortKey: "profit",
  sortDir: "desc",
  page: 1,
  pageSize: 50,
};

type FiltersAction =
  | { type: "set"; key: keyof FiltersState; value: any }
  | { type: "reset" }
  | { type: "setPage"; page: number };

function filtersReducer(state: FiltersState, action: FiltersAction): FiltersState {
  if (action.type === "reset") return { ...initialFilters };
  if (action.type === "setPage") return { ...state, page: Math.max(1, action.page) };

  const next = { ...state, [action.key]: action.value } as FiltersState;

  // 改筛选 / 排序 -> 重置到第一页（删掉以前那条依赖很长的 useEffect）
  const resetsPageKeys: Array<keyof FiltersState> = [
    "status",
    "category",
    "group",
    "q",
    "paidStartYmd",
    "paidEndYmd",
    "payoutStartYmd",
    "payoutEndYmd",
    "sortKey",
    "sortDir",
    "pageSize",
  ];

  if (resetsPageKeys.includes(action.key)) next.page = 1;
  return next;
}

/** ========== Excel parsing (single responsibility) ========== */
function mapRawRowsToRows(raw: RawRow[]): Row[] {
  if (!raw.length) return [];

  // 只对第一行做一次表头匹配，然后复用，避免每行都扫描
  const sample = raw[0];
  const kSku = pickKey(sample, ["库存sku", "SKU", "sku"]);
  const kName = pickKey(sample, ["商品名称", "标题", "名称"]);
  const kCat = pickKey(sample, ["卡片类目", "类目"]);
  const kStatus = pickKey(sample, ["回款状态"]);

  const kQty = pickKey(sample, ["售出数量", "数量"]);
  const kGmv = pickKey(sample, ["成交金额($)", "成交金额USD", "成交金额"]);
  const kPayout = pickKey(sample, ["回款金额(¥)", "回款金额CNY", "回款金额"]);

  const kPaidAt = pickKey(sample, ["eBay用户付款时间", "付款时间"]);
  const kPayoutAt = pickKey(sample, ["回款时间"]);

  return raw.map((r) => {
    const sku = kSku ? String(r[kSku]).trim() : "";
    const name = kName ? String(r[kName]).trim() : "";
    const cat = kCat ? String(r[kCat]).trim() : "";
    const payoutStatus = kStatus ? String(r[kStatus]).trim() : "未知";

    return {
      sku,
      name,
      category: cat,
      payoutStatus,
      soldQty: toNumber(kQty ? r[kQty] : 0),
      gmvUsd: toNumber(kGmv ? r[kGmv] : 0),
      payoutCny: toNumber(kPayout ? r[kPayout] : 0),
      paidAt: kPaidAt ? excelDateToJSDate(r[kPaidAt]) : null,
      payoutAt: kPayoutAt ? excelDateToJSDate(r[kPayoutAt]) : null,
      titleGroup: classifyTitleGroup(name),
    };
  });
}

/** ========== Export helpers ========== */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportRowsToCSV(rows: Row[], costPerLotForRow: (r: Row) => number) {
  const headers = [
    "titleGroup",
    "sku",
    "name",
    "category",
    "payoutStatus",
    "soldQty",
    "lotCount",
    "gmvUsd",
    "payoutCny",
    "costPerLotCny",
    "totalCostCny",
    "profitCny",
    "paidAt",
    "payoutAt",
  ];

  const lines = [headers.join(",")];

  rows.forEach((r) => {
    const lot = parseLotCountFromTitle(r.name);
    const cpl = costPerLotForRow(r);
    const totalCost = cpl * lot;
    const profit = r.payoutCny ? r.payoutCny - totalCost : 0;

    const values: any[] = [
      r.titleGroup,
      r.sku,
      r.name,
      r.category,
      r.payoutStatus,
      r.soldQty,
      lot,
      r.gmvUsd,
      r.payoutCny,
      cpl,
      totalCost,
      profit,
      r.paidAt ? r.paidAt.toISOString() : "",
      r.payoutAt ? r.payoutAt.toISOString() : "",
    ];

    const escaped = values.map((v) => {
      const s = String(v ?? "");
      // CSV escape: quote if contains comma/quote/newline
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    });

    lines.push(escaped.join(","));
  });

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `ebay_dashboard_${new Date().toISOString().slice(0, 10)}.csv`);
}

function exportRowsToExcel(rows: Row[], costPerLotForRow: (r: Row) => number) {
  const data = rows.map((r) => {
    const lot = parseLotCountFromTitle(r.name);
    const cpl = costPerLotForRow(r);
    const totalCost = cpl * lot;
    const profit = r.payoutCny ? r.payoutCny - totalCost : 0;

    return {
      titleGroup: r.titleGroup,
      sku: r.sku,
      name: r.name,
      category: r.category,
      payoutStatus: r.payoutStatus,
      soldQty: r.soldQty,
      lotCount: lot,
      gmvUsd: r.gmvUsd,
      payoutCny: r.payoutCny,
      costPerLotCny: cpl,
      totalCostCny: totalCost,
      profitCny: profit,
      paidAt: r.paidAt ? r.paidAt.toISOString() : "",
      payoutAt: r.payoutAt ? r.payoutAt.toISOString() : "",
    };
  });

  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Orders");
  XLSX.writeFile(wb, `ebay_dashboard_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/** ========== UI Components ========== */
function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ ...card(), ...cardPad() }}>
      <div style={smallStyle()}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 950, marginTop: 8, color: "#0f172a" }}>{value}</div>
      {sub ? <div style={{ marginTop: 6, ...smallStyle() }}>{sub}</div> : null}
    </div>
  );
}

function KpiGrid({ kpi }: { kpi: { baseCount: number; listCount: number; gmvUsd: number; payoutCny: number; totalCost: number; totalProfit: number; margin: number } }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
      <KpiCard label="订单行数（基础/筛选）" value={`${kpi.listCount} / ${kpi.baseCount}`} sub="基础：不含日期；筛选：含两套日期范围" />
      <KpiCard label="GMV（付款口径）" value={`$${money(kpi.gmvUsd)}`} />
      <KpiCard label="回款（回款口径）" value={`¥${money(kpi.payoutCny)}`} />
      <KpiCard label="利润 / 利润率" value={`¥${money(kpi.totalProfit)}`} sub={`${(kpi.margin * 100).toFixed(1)}%`} />
    </div>
  );
}

function ReportCard({ report, onCopy, isDisabled }: { report: ReportPayload; onCopy: () => void; isDisabled?: boolean }) {
  return (
    <div style={{ ...card(), ...cardPad(), display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ fontWeight: 950 }}>自动分析报告</div>
        <div style={{ flex: 1 }} />
        <button onClick={onCopy} disabled={isDisabled} style={isDisabled ? { ...btnGhostSm(), opacity: 0.5, cursor: "not-allowed" } : btnPrimarySm()}>
          复制报告
        </button>
      </div>

      <div style={{ color: "#0f172a", lineHeight: 1.5 }}>{report.summary}</div>
      <div style={{ ...smallStyle() }}>{report.statusLine}</div>
      <div style={{ ...smallStyle() }}>{report.note}</div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, marginTop: 4 }}>
        <div>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>亮点</div>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {report.highlights.length ? report.highlights.map((x, i) => <li key={i} style={{ marginBottom: 6, color: "#0f172a", fontSize: 13 }}>{x}</li>) : <li style={{ color: "#64748b", fontSize: 13 }}>暂无</li>}
          </ul>
        </div>
        <div>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>风险</div>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {report.risks.length ? report.risks.map((x, i) => <li key={i} style={{ marginBottom: 6, color: "#0f172a", fontSize: 13 }}>{x}</li>) : <li style={{ color: "#64748b", fontSize: 13 }}>暂无</li>}
          </ul>
        </div>
        <div>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>建议动作</div>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {report.actions.length ? report.actions.map((x, i) => <li key={i} style={{ marginBottom: 6, color: "#0f172a", fontSize: 13 }}>{x}</li>) : <li style={{ color: "#64748b", fontSize: 13 }}>暂无</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}

function FilterPanel(props: {
  isParsing: boolean;
  onFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onExportCSV: () => void;
  onExportExcel: () => void;
  exportDisabled: boolean;

  filters: FiltersState;
  dispatch: React.Dispatch<FiltersAction>;
  statusOptions: string[];
  categoryOptions: string[];
  groupOptions: string[];
  onReset: () => void;
}) {
  const { isParsing, onFile, onExportCSV, onExportExcel, exportDisabled, filters, dispatch, statusOptions, categoryOptions, groupOptions, onReset } = props;

  return (
    <div style={{ ...card(), ...cardPad(), position: "sticky", top: 16, height: "fit-content" }}>
      <div style={{ fontWeight: 950 }}>控制台</div>

      <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
        <label>
          <div style={smallStyle()}>上传 Excel</div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 6 }}>
            <input type="file" accept=".xlsx,.xls" onChange={onFile} disabled={isParsing} />
            {isParsing ? <div style={{ ...smallStyle() }}>解析中…</div> : null}
          </div>
        </label>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={onExportCSV} disabled={exportDisabled} style={exportDisabled ? { ...btnGhostSm(), opacity: 0.5, cursor: "not-allowed" } : btnGhostSm()}>
            导出 CSV（筛选后）
          </button>
          <button onClick={onExportExcel} disabled={exportDisabled} style={exportDisabled ? { ...btnGhostSm(), opacity: 0.5, cursor: "not-allowed" } : btnGhostSm()}>
            导出 Excel（筛选后）
          </button>
          <button onClick={onReset} style={btnGhostSm()}>
            清空筛选
          </button>
        </div>

        <label>
          <div style={smallStyle()}>回款状态</div>
          <select value={filters.status} onChange={(e) => dispatch({ type: "set", key: "status", value: e.target.value })} style={{ ...inputBase(), marginTop: 6 }}>
            {statusOptions.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>

        <label>
          <div style={smallStyle()}>类目</div>
          <select value={filters.category} onChange={(e) => dispatch({ type: "set", key: "category", value: e.target.value })} style={{ ...inputBase(), marginTop: 6 }}>
            {categoryOptions.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>

        <label>
          <div style={smallStyle()}>标题分类</div>
          <select value={filters.group} onChange={(e) => dispatch({ type: "set", key: "group", value: e.target.value })} style={{ ...inputBase(), marginTop: 6 }}>
            {groupOptions.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>

        <label>
          <div style={smallStyle()}>搜索（SKU/标题）</div>
          <input value={filters.q} onChange={(e) => dispatch({ type: "set", key: "q", value: e.target.value })} placeholder="输入关键词…" style={{ ...inputBase(), marginTop: 6 }} />
        </label>

        <label>
          <div style={smallStyle()}>付款时间范围（GMV）</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 6 }}>
            <input type="date" value={filters.paidStartYmd} onChange={(e) => dispatch({ type: "set", key: "paidStartYmd", value: e.target.value })} style={inputBase()} />
            <input type="date" value={filters.paidEndYmd} onChange={(e) => dispatch({ type: "set", key: "paidEndYmd", value: e.target.value })} style={inputBase()} />
          </div>
        </label>

        <label>
          <div style={smallStyle()}>回款时间范围（回款/利润）</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 6 }}>
            <input type="date" value={filters.payoutStartYmd} onChange={(e) => dispatch({ type: "set", key: "payoutStartYmd", value: e.target.value })} style={inputBase()} />
            <input type="date" value={filters.payoutEndYmd} onChange={(e) => dispatch({ type: "set", key: "payoutEndYmd", value: e.target.value })} style={inputBase()} />
          </div>
        </label>
      </div>

      <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #f1f5f9" }}>
        <div style={smallStyle()}>
          口径：GMV 按【付款时间】；回款/利润按【回款时间】（两套时间范围互不影响）。
        </div>
      </div>
    </div>
  );
}

function OverviewCharts(props: {
  overviewView: OverviewView;
  setOverviewView: (v: OverviewView) => void;
  top10: { gmv: TopItem[]; payout: TopItem[]; profit: TopItem[] };
  gmvSeries: DailyPoint[];
  payoutSeries: DailyPoint[];
  profitSeries: DailyPoint[];
  otherRows: Row[];
}) {
  const { overviewView, setOverviewView, top10, gmvSeries, payoutSeries, profitSeries, otherRows } = props;

  const Views: Array<{ key: OverviewView; label: string }> = [
    { key: "top10-profit", label: "Top10 利润" },
    { key: "top10-payout", label: "Top10 回款" },
    { key: "top10-gmv", label: "Top10 GMV" },
    { key: "trend-profit", label: "趋势：利润" },
    { key: "trend-payout", label: "趋势：回款" },
    { key: "trend-gmv", label: "趋势：GMV" },
    { key: "other", label: "Other 清单" },
  ];

  const chartCard: React.CSSProperties = { ...card(), ...cardPad(), minHeight: 420, display: "grid", gridTemplateRows: "auto 1fr" };

  return (
    <div style={chartCard}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        {Views.map((v) => (
          <button key={v.key} onClick={() => setOverviewView(v.key)} style={pill(overviewView === v.key)}>
            {v.label}
          </button>
        ))}
      </div>

      <div style={{ height: 360 }}>
        {overviewView === "top10-profit" && (
          <>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>利润 Top10（回款口径）</div>
            <ResponsiveContainer>
              <BarChart data={top10.profit} margin={{ left: 10, right: 20, bottom: 30 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="group" angle={-30} textAnchor="end" height={60} interval={0} />
                <YAxis />
                <Tooltip />
                <Bar dataKey="value" name="利润(¥)" fill="#0f172a" />
              </BarChart>
            </ResponsiveContainer>
          </>
        )}

        {overviewView === "top10-payout" && (
          <>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>回款 Top10（回款口径）</div>
            <ResponsiveContainer>
              <BarChart data={top10.payout} margin={{ left: 10, right: 20, bottom: 30 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="group" angle={-30} textAnchor="end" height={60} interval={0} />
                <YAxis />
                <Tooltip />
                <Bar dataKey="value" name="回款(¥)" fill="#0f766e" />
              </BarChart>
            </ResponsiveContainer>
          </>
        )}

        {overviewView === "top10-gmv" && (
          <>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>GMV Top10（付款口径）</div>
            <ResponsiveContainer>
              <BarChart data={top10.gmv} margin={{ left: 10, right: 20, bottom: 30 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="group" angle={-30} textAnchor="end" height={60} interval={0} />
                <YAxis />
                <Tooltip />
                <Bar dataKey="value" name="GMV($)" fill="#2563eb" />
              </BarChart>
            </ResponsiveContainer>
          </>
        )}

        {overviewView === "trend-gmv" && (
          <>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>GMV 按天趋势（付款时间）</div>
            <ResponsiveContainer>
              <LineChart data={gmvSeries} margin={{ left: 10, right: 20, bottom: 30 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" angle={-30} textAnchor="end" height={60} interval="preserveStartEnd" />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="value" name="GMV($)" stroke="#111827" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </>
        )}

        {overviewView === "trend-payout" && (
          <>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>回款 按天趋势（回款时间）</div>
            <ResponsiveContainer>
              <LineChart data={payoutSeries} margin={{ left: 10, right: 20, bottom: 30 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" angle={-30} textAnchor="end" height={60} interval="preserveStartEnd" />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="value" name="回款(¥)" stroke="#0f766e" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </>
        )}

        {overviewView === "trend-profit" && (
          <>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>利润 按天趋势（回款时间）</div>
            <ResponsiveContainer>
              <LineChart data={profitSeries} margin={{ left: 10, right: 20, bottom: 30 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" angle={-30} textAnchor="end" height={60} interval="preserveStartEnd" />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="value" name="利润(¥)" stroke="#0f172a" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </>
        )}

        {overviewView === "other" && (
          <>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Other（最多展示 200 行）</div>
            <div style={{ maxHeight: 330, overflow: "auto", border: "1px solid #f1f5f9", borderRadius: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #f1f5f9" }}>SKU</th>
                    <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #f1f5f9" }}>标题</th>
                    <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #f1f5f9" }}>类目</th>
                  </tr>
                </thead>
                <tbody>
                  {otherRows.map((r) => (
                    <tr key={rowId(r)}>
                      <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" }}>{r.sku}</td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9" }}>{r.name}</td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" }}>{r.category}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function OrdersTable(props: {
  rows: Row[];
  filters: FiltersState;
  dispatch: React.Dispatch<FiltersAction>;

  totalRows: number;
  pagedRows: Row[];

  costPerLotForRow: (r: Row) => number;
  totalCostOf: (r: Row) => number;
  profitOf: (r: Row) => number;

  rowCostOverride: Record<string, number>;
  setRowCostOverride: React.Dispatch<React.SetStateAction<Record<string, number>>>;
}) {
  const { rows, filters, dispatch, totalRows, pagedRows, costPerLotForRow, totalCostOf, profitOf, rowCostOverride, setRowCostOverride } = props;

  const totalPages = Math.max(1, Math.ceil(totalRows / filters.pageSize));
  const page = Math.min(filters.page, totalPages);

  useEffect(() => {
    if (filters.page !== page) dispatch({ type: "setPage", page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const headerCell: React.CSSProperties = { padding: 10, background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 12, fontWeight: 900, color: "#0f172a", textAlign: "left" };

  const thSortable = (key: SortKey, label: string) => {
    const active = filters.sortKey === key;
    const dir = active ? filters.sortDir : "desc";
    const icon = active ? (dir === "asc" ? "↑" : "↓") : "";
    return (
      <button
        onClick={() => {
          if (!active) dispatch({ type: "set", key: "sortKey", value: key });
          else dispatch({ type: "set", key: "sortDir", value: dir === "asc" ? "desc" : "asc" });
        }}
        style={{ border: "none", background: "transparent", cursor: "pointer", fontWeight: 900, fontSize: 12, color: "#0f172a" }}
      >
        {label} {icon}
      </button>
    );
  };

  return (
    <div style={{ ...card(), ...cardPad() }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div style={{ fontWeight: 950 }}>订单明细</div>
        <div style={{ ...smallStyle() }}>（共 {rows.length} 行；当前筛选 {totalRows} 行）</div>
        <div style={{ flex: 1 }} />

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={smallStyle()}>每页</div>
          <select value={filters.pageSize} onChange={(e) => dispatch({ type: "set", key: "pageSize", value: Number(e.target.value) })} style={{ ...inputBase(), width: 90 }}>
            {[20, 50, 100, 200].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>

          <button onClick={() => dispatch({ type: "setPage", page: Math.max(1, page - 1) })} style={btnGhostSm()} disabled={page <= 1}>
            上一页
          </button>
          <div style={{ ...smallStyle(), minWidth: 120, textAlign: "center" }}>
            第 {page} / {totalPages} 页
          </div>
          <button onClick={() => dispatch({ type: "setPage", page: Math.min(totalPages, page + 1) })} style={btnGhostSm()} disabled={page >= totalPages}>
            下一页
          </button>
        </div>
      </div>

      <div style={{ border: "1px solid #f1f5f9", borderRadius: 12, overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
          <thead>
            <tr>
              <th style={headerCell}>分类</th>
              <th style={headerCell}>SKU</th>
              <th style={headerCell}>标题</th>
              <th style={{ ...headerCell, textAlign: "right" }}>{thSortable("lot", "Lot")}</th>
              <th style={{ ...headerCell, textAlign: "right" }}>{thSortable("gmv", "GMV($)")}</th>
              <th style={{ ...headerCell, textAlign: "right" }}>{thSortable("payout", "回款(¥)")}</th>
              <th style={{ ...headerCell, textAlign: "right" }}>成本¥/lot（可覆盖）</th>
              <th style={{ ...headerCell, textAlign: "right" }}>总成本(¥)</th>
              <th style={{ ...headerCell, textAlign: "right" }}>{thSortable("profit", "利润(¥)")}</th>
              <th style={headerCell}>回款状态</th>
            </tr>
          </thead>
          <tbody>
            {pagedRows.map((r) => {
              const id = rowId(r);
              const lot = parseLotCountFromTitle(r.name);
              const cpl = costPerLotForRow(r);
              const cTotal = totalCostOf(r);
              const p = profitOf(r);
              const overrideVal = rowCostOverride[id];

              return (
                <tr key={id}>
                  <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" }}>{r.titleGroup}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" }}>{r.sku}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9" }}>{r.name}</td>

                  <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", textAlign: "right" }}>{lot}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", textAlign: "right" }}>${money(r.gmvUsd)}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", textAlign: "right" }}>¥{money(r.payoutCny)}</td>

                  <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", textAlign: "right" }}>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
                      <input
                        type="number"
                        step="0.1"
                        value={Number.isFinite(overrideVal) ? overrideVal : ""}
                        placeholder={String(cpl)}
                        onChange={(e) => {
                          const v = e.target.value;
                          setRowCostOverride((prev) => {
                            const next = { ...prev };
                            if (v === "" || !Number.isFinite(Number(v))) delete next[id];
                            else next[id] = Number(v);
                            return next;
                          });
                        }}
                        style={{ ...inputBase(), width: 120, textAlign: "right" }}
                      />
                      {Number.isFinite(overrideVal) ? (
                        <button
                          onClick={() => {
                            setRowCostOverride((prev) => {
                              const next = { ...prev };
                              delete next[id];
                              return next;
                            });
                          }}
                          style={btnGhostSm()}
                        >
                          还原
                        </button>
                      ) : null}
                    </div>
                  </td>

                  <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", textAlign: "right" }}>¥{money(cTotal)}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", textAlign: "right", fontWeight: 900, color: p >= 0 ? "#0f172a" : "#dc2626" }}>¥{money(p)}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" }}>{r.payoutStatus || "未知"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 10, ...smallStyle() }}>
        提示：成本优先使用“单条覆盖”，否则使用“分类默认成本”。覆盖会自动持久化到本地浏览器（localStorage）。
      </div>
    </div>
  );
}

function CostsPanel(props: {
  costMap: Record<string, number>;
  setCostMap: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  groupOptions: string[];
  rowCostOverride: Record<string, number>;
  setRowCostOverride: React.Dispatch<React.SetStateAction<Record<string, number>>>;
}) {
  const { costMap, setCostMap, groupOptions, rowCostOverride, setRowCostOverride } = props;

  const groups = useMemo(() => {
    // 让没有出现在数据里的默认组也能看到
    const s = new Set<string>(Object.keys(COST_DEFAULTS));
    groupOptions.forEach((g) => g !== "全部" && s.add(g));
    s.delete("全部");
    return Array.from(s).sort();
  }, [groupOptions]);

  const overrideCount = Object.keys(rowCostOverride).length;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 12 }}>
      <div style={{ ...card(), ...cardPad() }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <div style={{ fontWeight: 950 }}>分类默认成本（¥ / lot）</div>
          <div style={{ ...smallStyle() }}>修改后会影响利润计算（并自动保存到本地）</div>
        </div>

        <div style={{ border: "1px solid #f1f5f9", borderRadius: 12, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f8fafc" }}>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #f1f5f9" }}>分类</th>
                <th style={{ textAlign: "right", padding: 10, borderBottom: "1px solid #f1f5f9" }}>默认成本</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const v = Number.isFinite(costMap[g]) ? Number(costMap[g]) : 0;
                return (
                  <tr key={g}>
                    <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" }}>{g}</td>
                    <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", textAlign: "right" }}>
                      <input
                        type="number"
                        step="0.1"
                        value={v}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          setCostMap((prev) => ({ ...prev, [g]: Number.isFinite(n) ? n : 0 }));
                        }}
                        style={{ ...inputBase(), width: 140, textAlign: "right" }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ ...card(), ...cardPad(), height: "fit-content" }}>
        <div style={{ fontWeight: 950, marginBottom: 10 }}>单条成本覆盖</div>
        <div style={{ ...smallStyle(), marginBottom: 10 }}>
          当前有 {overrideCount} 条覆盖。覆盖用于处理“同分类但成本特殊”的订单。
        </div>

        <button
          onClick={() => {
            if (!overrideCount) return;
            setRowCostOverride({});
          }}
          disabled={!overrideCount}
          style={!overrideCount ? { ...btnGhostSm(), opacity: 0.5, cursor: "not-allowed" } : btnGhostSm()}
        >
          清空所有覆盖
        </button>

        <div style={{ marginTop: 12, ...smallStyle() }}>
          说明：覆盖不会改变分类规则，只影响成本与利润口径。你重新导入同一份 Excel（字段一致）也能尽量对上覆盖。
        </div>
      </div>
    </div>
  );
}

/** ========== Main Page ========== */
export default function Page() {
  const { toasts, push, remove } = useToast();

  const [tab, setTab] = useState<TabKey>("overview");
  const [overviewView, setOverviewView] = useState<OverviewView>("top10-profit");

  const [rows, setRows] = useState<Row[]>([]);
  const [isParsing, setIsParsing] = useState(false);

  const [filters, dispatch] = useReducer(filtersReducer, initialFilters);

  const [costMap, setCostMap] = useLocalStorageState<Record<string, number>>(LS_COST_MAP_KEY, { ...COST_DEFAULTS });
  const [rowCostOverride, setRowCostOverride] = useLocalStorageState<Record<string, number>>(LS_ROW_OVERRIDE_KEY, {});

  // 成本/利润计算：优先单条覆盖，否则用分类默认
  const calculators = useMemo(() => {
    const lotCountOf = (r: Row) => parseLotCountFromTitle(r.name);
    const costPerLotOfGroup = (g: string) => (Number.isFinite(costMap[g]) ? Number(costMap[g]) : 0);
    const costPerLotForRow = (r: Row) => {
      const id = rowId(r);
      const v = rowCostOverride[id];
      return Number.isFinite(v) ? Number(v) : costPerLotOfGroup(r.titleGroup);
    };
    const totalCostOf = (r: Row) => costPerLotForRow(r) * lotCountOf(r);
    const totalCostOfDefault = (r: Row) => costPerLotOfGroup(r.titleGroup) * lotCountOf(r);
    const profitOf = (r: Row) => (r.payoutCny ? r.payoutCny - totalCostOf(r) : 0);
    const profitOfDefault = (r: Row) => (r.payoutCny ? r.payoutCny - totalCostOfDefault(r) : 0);
    return { lotCountOf, costPerLotOfGroup, costPerLotForRow, totalCostOf, totalCostOfDefault, profitOf, profitOfDefault };
  }, [costMap, rowCostOverride]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsParsing(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<RawRow>(ws, { defval: "" });

      const mapped = mapRawRowsToRows(raw);
      setRows(mapped);

      setTab("overview");
      setOverviewView("top10-profit");

      push("success", `已加载 ${mapped.length} 行数据`);
    } catch (err: any) {
      push("error", `解析失败：${err?.message ?? String(err)}`);
    } finally {
      setIsParsing(false);
      // 允许再次选择同一文件
      e.target.value = "";
    }
  }

  const statusOptions = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => s.add((r.payoutStatus || "未知").trim() || "未知"));
    return ["全部", ...Array.from(s).sort()];
  }, [rows]);

  const categoryOptions = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => {
      const c = (r.category || "").trim();
      if (c) s.add(c);
    });
    return ["全部", ...Array.from(s).sort()];
  }, [rows]);

  const groupOptions = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => s.add((r.titleGroup || "Other").trim() || "Other"));
    return ["全部", ...Array.from(s).sort()];
  }, [rows]);

  /** 基础筛选（不含日期） */
  const baseRows = useMemo(() => {
    const qq = filters.q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filters.status !== "全部" && (r.payoutStatus || "未知") !== filters.status) return false;
      if (filters.category !== "全部" && (r.category || "") !== filters.category) return false;
      if (filters.group !== "全部" && (r.titleGroup || "Other") !== filters.group) return false;

      if (qq) {
        const sku = (r.sku || "").toLowerCase();
        const name = (r.name || "").toLowerCase();
        if (!sku.includes(qq) && !name.includes(qq)) return false;
      }
      return true;
    });
  }, [rows, filters.status, filters.category, filters.group, filters.q]);

  /** GMV：按付款时间的筛选（只影响 GMV 口径） */
  const paidRows = useMemo(() => {
    return filterByDate(baseRows, (r) => r.paidAt, filters.paidStartYmd, filters.paidEndYmd);
  }, [baseRows, filters.paidStartYmd, filters.paidEndYmd]);

  /** 回款/利润：按回款时间筛选（只影响回款与利润口径） */
  const payoutRows = useMemo(() => {
    return filterByDate(baseRows, (r) => r.payoutAt, filters.payoutStartYmd, filters.payoutEndYmd);
  }, [baseRows, filters.payoutStartYmd, filters.payoutEndYmd]);

  /** 明细列表：同时应用两套日期范围（用户填了就生效） */
  const listRows = useMemo(() => {
    let out = baseRows;
    out = filterByDate(out, (r) => r.paidAt, filters.paidStartYmd, filters.paidEndYmd);
    out = filterByDate(out, (r) => r.payoutAt, filters.payoutStartYmd, filters.payoutEndYmd);
    return out;
  }, [baseRows, filters.paidStartYmd, filters.paidEndYmd, filters.payoutStartYmd, filters.payoutEndYmd]);

  /** KPI */
  const kpi = useMemo(() => {
    const gmvUsd = paidRows.reduce((s, r) => s + (r.gmvUsd || 0), 0);
    const payoutCny = payoutRows.reduce((s, r) => s + (r.payoutCny || 0), 0);

    const totalCost = payoutRows.reduce((s, r) => s + (r.payoutCny ? calculators.totalCostOf(r) : 0), 0);
    const totalProfit = payoutRows.reduce((s, r) => s + calculators.profitOf(r), 0);
    const margin = payoutCny > 0 ? totalProfit / payoutCny : 0;

    return {
      baseCount: baseRows.length,
      listCount: listRows.length,
      gmvUsd,
      payoutCny,
      totalCost,
      totalProfit,
      margin,
    };
  }, [baseRows.length, listRows.length, paidRows, payoutRows, calculators]);

  /** Top10 */
  const top10 = useMemo(() => {
    const agg = (input: Row[], getVal: (r: Row) => number) => {
      const m = new Map<string, number>();
      input.forEach((r) => {
        const g = (r.titleGroup || "Other").trim() || "Other";
        m.set(g, (m.get(g) ?? 0) + (getVal(r) || 0));
      });
      return Array.from(m.entries())
        .map(([group, value]) => ({ group, value: Number(value.toFixed(2)) }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 10);
    };

    return {
      gmv: agg(paidRows, (r) => r.gmvUsd),
      payout: agg(payoutRows, (r) => r.payoutCny),
      profit: agg(payoutRows, (r) => calculators.profitOf(r)),
    };
  }, [paidRows, payoutRows, calculators]);

  /** Other 清单 */
  const otherRows = useMemo(() => {
    return baseRows.filter((r) => (r.titleGroup || "Other") === "Other").slice(0, 200);
  }, [baseRows]);

  /** 趋势 */
  const gmvSeries = useMemo(() => buildDailySeries(paidRows, (r) => r.paidAt, (r) => r.gmvUsd, filters.paidStartYmd, filters.paidEndYmd), [
    paidRows,
    filters.paidStartYmd,
    filters.paidEndYmd,
  ]);
  const payoutSeries = useMemo(() => buildDailySeries(payoutRows, (r) => r.payoutAt, (r) => r.payoutCny, filters.payoutStartYmd, filters.payoutEndYmd), [
    payoutRows,
    filters.payoutStartYmd,
    filters.payoutEndYmd,
  ]);
  const profitSeries = useMemo(() => buildDailySeries(payoutRows, (r) => r.payoutAt, (r) => calculators.profitOf(r), filters.payoutStartYmd, filters.payoutEndYmd), [
    payoutRows,
    filters.payoutStartYmd,
    filters.payoutEndYmd,
    calculators,
  ]);

  /** 报告 */
  const report = useMemo<ReportPayload>(() => {
      const paidRange =
        filters.paidStartYmd || filters.paidEndYmd
          ? `${filters.paidStartYmd || "最早"} ~ ${filters.paidEndYmd || "最新"}`
          : "全量";
      const payoutRange =
        filters.payoutStartYmd || filters.payoutEndYmd
          ? `${filters.payoutStartYmd || "最早"} ~ ${filters.payoutEndYmd || "最新"}`
          : "全量";

      const baseCount = baseRows.length;
      const paidCount = paidRows.length;
      const payoutCount = payoutRows.length;
      const listCount = listRows.length;

      const avgGmv = paidCount ? kpi.gmvUsd / paidCount : 0;
      const avgPayout = payoutCount ? kpi.payoutCny / payoutCount : 0;
      const avgProfit = payoutCount ? kpi.totalProfit / payoutCount : 0;

      const payoutVals = payoutRows.map((r) => r.payoutCny || 0).filter((x) => x > 0);
      const profitVals = payoutRows.map((r) => calculators.profitOf(r)).filter((x) => Number.isFinite(x) && x !== 0);

      const medPayout = median(payoutVals);
      const p10Payout = percentile(payoutVals, 0.1);
      const p90Payout = percentile(payoutVals, 0.9);

      const medProfit = median(profitVals);
      const p10Profit = percentile(profitVals, 0.1);
      const p90Profit = percentile(profitVals, 0.9);

      // 回款周期（天）：仅统计 paidAt 与 payoutAt 都存在的订单
      const delays = payoutRows
        .map((r) => {
          if (!r.paidAt || !r.payoutAt) return NaN;
          const d = Math.round((endOfDay(r.payoutAt).getTime() - endOfDay(r.paidAt).getTime()) / (24 * 3600 * 1000));
          return Number.isFinite(d) ? d : NaN;
        })
        .filter((x) => Number.isFinite(x) && x >= 0) as number[];

      const medDelay = median(delays);
      const p90Delay = percentile(delays, 0.9);

      // 待回款（付款在范围内，但未回款）
      const awaitingRows = paidRows.filter((r) => !!r.paidAt && !r.payoutAt);
      const awaitingCount = awaitingRows.length;
      const awaitingGmv = awaitingRows.reduce((s, r) => s + (r.gmvUsd || 0), 0);

      // 状态分布（基础口径）
      const statusCount = new Map<string, number>();
      baseRows.forEach((r) => {
        const s = (r.payoutStatus || "未知").trim() || "未知";
        statusCount.set(s, (statusCount.get(s) ?? 0) + 1);
      });
      const statusSorted = Array.from(statusCount.entries()).sort((a, b) => b[1] - a[1]);
      const statusTop = statusSorted.slice(0, 3);

      const statusLine = statusTop.length
        ? `回款状态Top3（基础口径）：${statusTop.map(([s, c]) => `${s}(${c})`).join("、")}${statusSorted.length > 3 ? `（共${statusSorted.length}类）` : ""}`
        : "回款状态Top3（基础口径）：无";

      // 分类聚合（付款口径：GMV；回款口径：回款/利润/lot）
      type GStat = { countPaid: number; countPayout: number; gmv: number; payout: number; profit: number; lots: number };
      const gmap = new Map<string, GStat>();
      const ensure = (g: string) => {
        if (!gmap.has(g)) gmap.set(g, { countPaid: 0, countPayout: 0, gmv: 0, payout: 0, profit: 0, lots: 0 });
        return gmap.get(g)!;
      };

      paidRows.forEach((r) => {
        const g = (r.titleGroup || "Other").trim() || "Other";
        const st = ensure(g);
        st.countPaid += 1;
        st.gmv += r.gmvUsd || 0;
      });

      payoutRows.forEach((r) => {
        const g = (r.titleGroup || "Other").trim() || "Other";
        const st = ensure(g);
        st.countPayout += 1;
        st.payout += r.payoutCny || 0;
        st.profit += calculators.profitOf(r);
        st.lots += calculators.lotCountOf(r);
      });

      const groups = Array.from(gmap.entries()).map(([group, v]) => ({ group, ...v }));

      const topProfit = top10.profit[0];
      const topPayout = top10.payout[0];
      const topGmv = top10.gmv[0];

      const bestMargin = groups
        .filter((x) => x.payout > 0 && x.countPayout >= 3)
        .map((x) => ({ ...x, margin: x.profit / x.payout }))
        .sort((a, b) => b.margin - a.margin)[0];

      const worstMargin = groups
        .filter((x) => x.payout > 0 && x.countPayout >= 3)
        .map((x) => ({ ...x, margin: x.profit / x.payout }))
        .sort((a, b) => a.margin - b.margin)[0];

      const otherCount = baseRows.filter((r) => (r.titleGroup || "Other") === "Other").length;

      // 异常：负利润订单（回款口径）
      const negRows = payoutRows
        .map((r) => ({ r, p: calculators.profitOf(r) }))
        .filter((x) => x.p < 0)
        .sort((a, b) => a.p - b.p);
      const negCount = negRows.length;
      const negSum = negRows.reduce((s, x) => s + x.p, 0);

      const worstNeg3 = negRows.slice(0, 3).map((x) => {
        const sku = x.r.sku ? `SKU:${x.r.sku}` : "SKU:—";
        const name = (x.r.name || "").slice(0, 38) + ((x.r.name || "").length > 38 ? "…" : "");
        return `${sku} ${name}（¥${money(x.p)}）`;
      });

      // 异常：回款延迟 Top3（天）
      const delayTop3 = payoutRows
        .map((r) => {
          if (!r.paidAt || !r.payoutAt) return null;
          const d = Math.round((endOfDay(r.payoutAt).getTime() - endOfDay(r.paidAt).getTime()) / (24 * 3600 * 1000));
          if (!Number.isFinite(d) || d < 0) return null;
          return { r, d };
        })
        .filter(Boolean) as Array<{ r: Row; d: number }>;
      delayTop3.sort((a, b) => b.d - a.d);
      const slow3 = delayTop3.slice(0, 3).map((x) => {
        const name = (x.r.name || "").slice(0, 34) + ((x.r.name || "").length > 34 ? "…" : "");
        return `${x.d}天：${x.r.titleGroup || "Other"} / ${name}`;
      });

      // 时间序列对比：最近 N 天 vs 前 N 天（N=3~7）
      const tailCompare = (series: DailyPoint[], n: number) => {
        if (series.length < n * 2) return null;
        let cur = 0;
        let prev = 0;
        for (let i = series.length - n; i < series.length; i++) cur += series[i]?.value || 0;
        for (let i = series.length - n * 2; i < series.length - n; i++) prev += series[i]?.value || 0;
        const delta = cur - prev;
        const pct = prev !== 0 ? delta / prev : null;
        return { cur, prev, delta, pct };
      };

      const n = Math.min(7, Math.max(3, Math.floor(Math.min(gmvSeries.length, payoutSeries.length, profitSeries.length) / 2)));
      const gmvCmp = tailCompare(gmvSeries, n);
      const payoutCmp = tailCompare(payoutSeries, n);
      const profitCmp = tailCompare(profitSeries, n);

      const fmtPct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
      const fmtDelta = (x: number) => `${x >= 0 ? "+" : ""}${money(x)}`;

      // 单条覆盖统计
      const overrideKeys = Object.keys(rowCostOverride);
      const overrideCountAll = overrideKeys.length;

      let overrideCountInView = 0;
      let profitDeltaSum = 0;

      const overrideImpact = payoutRows
        .map((r) => {
          const id = rowId(r);
          const hasOverride = Number.isFinite(rowCostOverride[id]);
          if (!hasOverride) return null;
          const delta = calculators.profitOf(r) - calculators.profitOfDefault(r);
          return { r, delta };
        })
        .filter(Boolean) as Array<{ r: Row; delta: number }>;
      overrideImpact.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      const overrideTop3 = overrideImpact.slice(0, 3).map((x) => {
        const name = (x.r.name || "").slice(0, 36) + ((x.r.name || "").length > 36 ? "…" : "");
        return `${x.r.titleGroup || "Other"} / ${name}（利润变化 ¥${fmtDelta(x.delta)}）`;
      });

      payoutRows.forEach((r) => {
        const id = rowId(r);
        if (Number.isFinite(rowCostOverride[id])) {
          overrideCountInView += 1;
          profitDeltaSum += calculators.profitOf(r) - calculators.profitOfDefault(r);
        }
      });

      // 数据质量提示
      const missingPaidAt = baseRows.filter((r) => !r.paidAt).length;
      const missingPayoutAtWithAmount = baseRows.filter((r) => (r.payoutCny || 0) > 0 && !r.payoutAt).length;
      const missingPayoutAmountWithDate = baseRows.filter((r) => !!r.payoutAt && !(r.payoutCny > 0)).length;

      const summary =
        `范围：付款[${paidRange}]，回款[${payoutRange}]。` +
        ` 行数：基础${baseCount}；明细(双日期交集)${listCount}；付款${paidCount}；回款${payoutCount}。` +
        ` GMV(付款) $${money(kpi.gmvUsd)}（AOV $${money(avgGmv)}）；回款(回款) ¥${money(kpi.payoutCny)}（¥${money(avgPayout)}/单）；` +
        ` 利润 ¥${money(kpi.totalProfit)}（利润率 ${(kpi.margin * 100).toFixed(1)}%，¥${money(avgProfit)}/单）。`;

      const highlights: string[] = [];

      if (topProfit) {
        const share = kpi.totalProfit !== 0 ? topProfit.value / kpi.totalProfit : 0;
        highlights.push(`利润Top1：${topProfit.group}（¥${money(topProfit.value)}，占比约 ${(share * 100).toFixed(1)}%）`);
      }
      if (topPayout) highlights.push(`回款Top1：${topPayout.group}（¥${money(topPayout.value)}）`);
      if (topGmv) highlights.push(`GMV Top1：${topGmv.group}（$${money(topGmv.value)}）`);

      if (bestMargin) highlights.push(`最佳毛利（≥3单）：${bestMargin.group}（毛利率 ${(bestMargin.margin * 100).toFixed(1)}%）`);
      if (worstMargin) highlights.push(`最低毛利（≥3单）：${worstMargin.group}（毛利率 ${(worstMargin.margin * 100).toFixed(1)}%）`);

      if (payoutVals.length >= 10) highlights.push(`回款分布：P10=¥${money(p10Payout)} / 中位=¥${money(medPayout)} / P90=¥${money(p90Payout)}`);
      if (profitVals.length >= 10) highlights.push(`利润分布：P10=¥${money(p10Profit)} / 中位=¥${money(medProfit)} / P90=¥${money(p90Profit)}`);
      if (delays.length >= 10) highlights.push(`回款周期：中位 ${medDelay} 天 / P90 ${p90Delay} 天`);

      if (gmvCmp && payoutCmp && profitCmp) {
        highlights.push(
          `近期${n}天 vs 前${n}天：GMV $${money(gmvCmp.cur)}（${fmtPct(gmvCmp.pct)}）；回款 ¥${money(payoutCmp.cur)}（${fmtPct(payoutCmp.pct)}）；利润 ¥${money(profitCmp.cur)}（${fmtPct(profitCmp.pct)}）`
        );
      }

      const risks: string[] = [];

      if (kpi.payoutCny > 0 && kpi.margin < 0.1) risks.push("整体利润率偏低（<10%），注意成本口径或低价出货风险。");
      if (kpi.totalProfit < 0) risks.push("当前回款口径利润为负，请优先排查异常成本/低价订单。");

      if (negCount > 0) risks.push(`存在负利润订单：${negCount} 单，合计 ¥${money(negSum)}（见最差Top3）。`);
      if (awaitingCount > 0) risks.push(`存在待回款：付款范围内 ${awaitingCount} 单未回款（GMV约 $${money(awaitingGmv)}）。`);

      if (otherCount > 0) risks.push(`分类命中不足：Other 共 ${otherCount} 行（建议补充分类规则）。`);
      if (overrideCountInView > 0) risks.push(`本视图内有 ${overrideCountInView} 条单条成本覆盖，利润合计变化 ¥${fmtDelta(profitDeltaSum)}。`);

      // 集中度风险：Top1 利润占比过高
      if (topProfit && kpi.totalProfit !== 0 && Math.abs(topProfit.value / kpi.totalProfit) > 0.6) risks.push("利润集中度较高（Top1 > 60%），注意对单一品类/标题组依赖。");
      if (payoutVals.length >= 10 && medPayout > 0 && p90Payout / medPayout >= 5) risks.push("回款分布长尾明显（P90 >> 中位），可能存在少量大额订单拉动。");

      if (missingPayoutAtWithAmount > 0) risks.push(`数据异常：存在 ${missingPayoutAtWithAmount} 行“有回款金额但无回款时间”。`);
      if (missingPayoutAmountWithDate > 0) risks.push(`数据异常：存在 ${missingPayoutAmountWithDate} 行“有回款时间但回款金额为空/0”。`);
      if (missingPaidAt > 0 && baseCount > 0 && missingPaidAt / baseCount > 0.3) risks.push("付款时间缺失比例较高（>30%），趋势与对比可能失真。");

      const actions: string[] = [];

      if (topProfit) actions.push(`复盘并扩量：重点关注【${topProfit.group}】的供货与定价策略（高利润贡献）。`);
      if (bestMargin) actions.push(`提升结构：适当提高【${bestMargin.group}】占比，减少低毛利组占比。`);
      if (worstMargin && worstMargin.margin < 0.05) actions.push(`治理低毛利：针对【${worstMargin.group}】复查成本默认值/定价，必要时设最低价或暂停。`);

      if (negCount > 0) actions.push(`逐单排查：先看负利润Top3，核对成本(lot)与标题解析(lot数)，必要时用“单条成本覆盖”修正。`);
      if (slow3.length) actions.push("回款提速：关注延迟Top3订单的状态与渠道，考虑优化回款路径/结算频率。");
      if (awaitingCount > 0) actions.push("跟进待回款：按回款状态筛出“处理中/待处理”订单，设置催款/对账节奏。");

      if (otherCount > 0) actions.push("补齐分类：将 Other 订单的高频关键词沉淀为规则（建议用优先级规则数组维护）。");

      if (overrideCountAll === 0) actions.push("如遇特殊成本：可在订单明细里用“单条成本¥/lot”覆盖（不影响分类默认成本）。");
      else actions.push("单条成本覆盖：建议定期整理成新的分类默认成本，避免覆盖长期堆积导致口径分裂。");

      const note =
        "口径说明：GMV 按【付款时间】筛选聚合；回款/利润按【回款时间】筛选聚合（两套时间范围互不影响）。" +
        ` 当前范围：付款[${paidRange}]；回款[${payoutRange}]。`;

      const copyText =
        `【自动分析报告】\n` +
        `${summary}\n` +
        `${statusLine}\n` +
        `\n` +
        `【亮点】\n- ${highlights.length ? highlights.join("\n- ") : "暂无"}\n\n` +
        `【风险】\n- ${risks.length ? risks.join("\n- ") : "暂无"}\n\n` +
        `【建议动作】\n- ${actions.length ? actions.join("\n- ") : "暂无"}\n\n` +
        `【异常Top】\n` +
        `- 负利润Top3：${worstNeg3.length ? worstNeg3.join("；") : "暂无"}\n` +
        `- 回款延迟Top3：${slow3.length ? slow3.join("；") : "暂无"}\n` +
        `\n` +
        `${note}\n` +
        `\n` +
        `单条成本覆盖：全局共 ${overrideCountAll} 条；本视图内影响 ¥${fmtDelta(profitDeltaSum)}。\n` +
        `${overrideTop3.length ? `覆盖影响Top3：\n- ${overrideTop3.join("\n- ")}\n` : ""}`;

      return { summary, highlights, risks, actions, statusLine, note, copyText };
    }, [
      top10,
      baseRows,
      paidRows,
      payoutRows,
      listRows,
      kpi,
      rowCostOverride,
      calculators,
      gmvSeries,
      payoutSeries,
      profitSeries,
      filters.paidStartYmd,
      filters.paidEndYmd,
      filters.payoutStartYmd,
      filters.payoutEndYmd,
    ]);
  /** 明细：排序 + 分页（全局 reducer 状态驱动） */
  const sortedListRows = useMemo(() => {
    const arr = [...listRows];

    const val = (r: Row) => {
      if (filters.sortKey === "profit") return calculators.profitOf(r);
      if (filters.sortKey === "payout") return r.payoutCny || 0;
      if (filters.sortKey === "gmv") return r.gmvUsd || 0;
      return calculators.lotCountOf(r);
    };

    arr.sort((a, b) => (val(a) - val(b)) * (filters.sortDir === "asc" ? 1 : -1));
    return arr;
  }, [listRows, filters.sortKey, filters.sortDir, calculators]);

  const pagedRows = useMemo(() => {
    const start = (filters.page - 1) * filters.pageSize;
    return sortedListRows.slice(start, start + filters.pageSize);
  }, [sortedListRows, filters.page, filters.pageSize]);

  const exportDisabled = listRows.length === 0;

  const onReset = () => {
    dispatch({ type: "reset" });
    push("info", "已清空筛选条件");
  };

  const onCopyReport = async () => {
    try {
      await navigator.clipboard.writeText(report.copyText);
      push("success", "已复制报告到剪贴板");
    } catch {
      push("error", "复制失败：浏览器可能不允许访问剪贴板");
    }
  };

  return (
    <div style={{ padding: 16, background: "#f8fafc", minHeight: "100vh" }}>
      <ToastStack toasts={toasts} onClose={remove} />

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 18, fontWeight: 950, color: "#0f172a" }}>eBay Excel Dashboard</div>
        <div style={{ ...smallStyle() }}>升级版（组件化 + Reducer + Toast + 导出）</div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setTab("overview")} style={pill(tab === "overview")}>
            Overview
          </button>
          <button onClick={() => setTab("orders")} style={pill(tab === "orders")}>
            Orders
          </button>
          <button onClick={() => setTab("costs")} style={pill(tab === "costs")}>
            Costs
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 12, alignItems: "start" }}>
        <FilterPanel
          isParsing={isParsing}
          onFile={onFile}
          filters={filters}
          dispatch={dispatch}
          statusOptions={statusOptions}
          categoryOptions={categoryOptions}
          groupOptions={groupOptions}
          onReset={onReset}
          onExportCSV={() => {
            exportRowsToCSV(listRows, calculators.costPerLotForRow);
            push("success", "已开始导出 CSV");
          }}
          onExportExcel={() => {
            exportRowsToExcel(listRows, calculators.costPerLotForRow);
            push("success", "已开始导出 Excel");
          }}
          exportDisabled={exportDisabled}
        />

        <div style={{ display: "grid", gap: 12 }}>
          <KpiGrid kpi={kpi} />

          {tab === "overview" && (
            <div style={{ display: "grid", gap: 12 }}>
              <ReportCard report={report} onCopy={onCopyReport} isDisabled={!rows.length} />
              <OverviewCharts
                overviewView={overviewView}
                setOverviewView={setOverviewView}
                top10={top10}
                gmvSeries={gmvSeries}
                payoutSeries={payoutSeries}
                profitSeries={profitSeries}
                otherRows={otherRows}
              />
            </div>
          )}

          {tab === "orders" && (
            <OrdersTable
              rows={rows}
              filters={filters}
              dispatch={dispatch}
              totalRows={sortedListRows.length}
              pagedRows={pagedRows}
              costPerLotForRow={calculators.costPerLotForRow}
              totalCostOf={calculators.totalCostOf}
              profitOf={calculators.profitOf}
              rowCostOverride={rowCostOverride}
              setRowCostOverride={setRowCostOverride}
            />
          )}

          {tab === "costs" && (
            <CostsPanel
              costMap={costMap}
              setCostMap={setCostMap}
              groupOptions={groupOptions}
              rowCostOverride={rowCostOverride}
              setRowCostOverride={setRowCostOverride}
            />
          )}
        </div>
      </div>

      <div style={{ marginTop: 12, ...smallStyle() }}>
        小贴士：如果后续要上 TanStack Table / 虚拟滚动，把 OrdersTable 单独迁移即可；当前结构已为后续扩展预留边界。
      </div>
    </div>
  );
}
