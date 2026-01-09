"use client";

import React, { useEffect, useMemo, useState } from "react";
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
  Other: 0,
};

/** ========== 标题分类（按你的规则） ========== */
function classifyTitleGroup(title: string) {
  const t = (title || "").replace(/\s+/g, " ").trim();

  const hasKfcPack = /\bkfc\b/i.test(t) && /\bpack(s)?\b/i.test(t);
  const hasOcd = /\bocd\b/i.test(t);
  const hasTagTeam = /tag\s*team/i.test(t);
  const hasSealed = /\bsealed\b/i.test(t);

  const hasMasterBall = /master\s*ball/i.test(t);
  const hasLogoReverseHolo = /logo\s*reverse\s*holo/i.test(t);
  const hasBallHolo = /ball\s*holo/i.test(t);
  const hasMix = /\bmix\b/i.test(t);

  const hasAR = /\bar\b/i.test(t);
  const hasCHR = /\bchr\b/i.test(t);

  const hasSR = /\bsr\b/i.test(t);
  const hasHR = /\bhr\b/i.test(t);

  const hasRRR = /\brrr\b/i.test(t);
  const hasRR = /\brr\b/i.test(t);
  const hasVMAX = /\bvmax\b/i.test(t);

  const isJapanese = /\bjapanese\b/i.test(t);

  const hasOtherRarity =
    /\brrrr\b/i.test(t) ||
    /\bur\b/i.test(t) ||
    /\bssr\b/i.test(t) ||
    hasSR ||
    hasHR ||
    hasAR ||
    hasCHR ||
    hasTagTeam;

  if (hasKfcPack) return "KFC Pack";
  if (hasOcd) return "OCD";
  if (hasTagTeam) return "TAG TEAM";
  if (hasSealed) return "Sealed";
  if (hasMasterBall) return "Master Ball";
  if (hasLogoReverseHolo) return "Logo Reverse Holo";
  if (hasBallHolo) return "Ball Holo";
  if (hasMix) return "Mix";
  if (hasAR || hasCHR) return "AR/CHR";
  if ((hasSR || hasHR) && !hasOcd) return "SR/HR";
  if (isJapanese) return "Japanese";

  if (hasRRR && hasVMAX && !hasRR && !hasOtherRarity) return "RRR+VMAX";
  if (hasRR && hasRRR && !hasOtherRarity) return "RR+RRR";
  if (hasRR && !hasRRR && !hasOtherRarity) return "RR Only";

  return "Other";
}

/** ========== 从标题解析 Lot 数量（100 Lot / Lot 100 / 1.50 Lot -> 150 容错） ========== */
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

/** ========== 工具：稳定 ID（用于单条成本覆盖） ========== */
function hashStr(str: string) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

function rowId(r: Row) {
  // 选“相对稳定”的字段：SKU+标题+付款时间+回款时间
  // 这样你重新导入同一个 Excel，大概率能对上之前的覆盖
  return hashStr(
    [
      r.sku || "",
      r.name || "",
      r.paidAt ? r.paidAt.toISOString() : "",
      r.payoutAt ? r.payoutAt.toISOString() : "",
    ].join("|")
  );
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

function pickKey(obj: RawRow, candidates: string[]) {
  const keys = Object.keys(obj);
  const normKeys = keys.map((k) => [k, normHeader(k)] as const);

  for (const c of candidates) {
    const nc = normHeader(c);
    const hit = normKeys.find(([, nk]) => nk === nc);
    if (hit) return hit[0];
  }
  for (const c of candidates) {
    const nc = normHeader(c);
    const hit = normKeys.find(([, nk]) => nk.includes(nc) || nc.includes(nk));
    if (hit) return hit[0];
  }
  return undefined;
}

function toNumber(v: any) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/,/g, "").replace(/[^\d.-]/g, "");
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
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
function endOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function filterByDate(
  input: Row[],
  getDt: (r: Row) => Date | null,
  startYmd: string,
  endYmd: string
) {
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
) {
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

  const out: Array<{ date: string; value: number }> = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const key = dayKey(d);
    out.push({ date: key, value: Number(((map.get(key) ?? 0) as number).toFixed(2)) });
  }
  return out;
}

/** ========== 统计工具 ========== */
function money(n: number, digits = 0) {
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

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
    fontSize: 13,
    fontWeight: 800,
    whiteSpace: "nowrap",
  };
}
function inputBase(): React.CSSProperties {
  return { padding: 10, borderRadius: 10, border: "1px solid #e2e8f0", width: "100%" };
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

export default function Page() {
  const [tab, setTab] = useState<TabKey>("overview");
  const [overviewView, setOverviewView] = useState<OverviewView>("top10-profit");
  const [rows, setRows] = useState<Row[]>([]);

  // 两套日期范围：GMV 用付款时间；回款/利润 用回款时间
  const [paidStartYmd, setPaidStartYmd] = useState("");
  const [paidEndYmd, setPaidEndYmd] = useState("");
  const [payoutStartYmd, setPayoutStartYmd] = useState("");
  const [payoutEndYmd, setPayoutEndYmd] = useState("");

  // 共用筛选
  const [status, setStatus] = useState("全部");
  const [category, setCategory] = useState("全部");
  const [group, setGroup] = useState("全部");
  const [q, setQ] = useState("");

  /** 分类成本表（可编辑） */
  const [costMap, setCostMap] = useState<Record<string, number>>(() => {
    if (typeof window === "undefined") return COST_DEFAULTS;
    try {
      const raw = localStorage.getItem("costMap_v5");
      if (raw) return { ...COST_DEFAULTS, ...JSON.parse(raw) };
    } catch {}
    return COST_DEFAULTS;
  });

  useEffect(() => {
    try {
      localStorage.setItem("costMap_v5", JSON.stringify(costMap));
    } catch {}
  }, [costMap]);

  /** 单条成本覆盖：key=rowId -> 成本(¥/lot) */
  const [rowCostOverride, setRowCostOverride] = useState<Record<string, number>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = localStorage.getItem("rowCostOverride_v2");
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("rowCostOverride_v2", JSON.stringify(rowCostOverride));
    } catch {}
  }, [rowCostOverride]);

  // 成本计算：优先单条覆盖，否则用分类默认
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

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json<RawRow>(ws, { defval: "" });

    const mapped: Row[] = raw.map((r) => {
      const kSku = pickKey(r, ["库存sku", "SKU", "sku"]);
      const kName = pickKey(r, ["商品名称", "标题", "名称"]);
      const kCat = pickKey(r, ["卡片类目", "类目"]);
      const kStatus = pickKey(r, ["回款状态"]);

      const kQty = pickKey(r, ["售出数量", "数量"]);
      const kGmv = pickKey(r, ["成交金额($)", "成交金额USD", "成交金额"]);
      const kPayout = pickKey(r, ["回款金额(¥)", "回款金额CNY", "回款金额"]);

      const kPaidAt = pickKey(r, ["eBay用户付款时间", "付款时间"]);
      const kPayoutAt = pickKey(r, ["回款时间"]);

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

    setRows(mapped);
    setTab("overview");
    setOverviewView("top10-profit");
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

  const costGroups = useMemo(() => {
    const s = new Set<string>(Object.keys(COST_DEFAULTS));
    groupOptions.forEach((g) => g !== "全部" && s.add(g));
    return Array.from(s).sort();
  }, [groupOptions]);

  /** 基础筛选（不含日期） */
  const baseRows = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (status !== "全部" && (r.payoutStatus || "未知") !== status) return false;
      if (category !== "全部" && (r.category || "") !== category) return false;
      if (group !== "全部" && (r.titleGroup || "Other") !== group) return false;

      if (qq) {
        const sku = (r.sku || "").toLowerCase();
        const name = (r.name || "").toLowerCase();
        if (!sku.includes(qq) && !name.includes(qq)) return false;
      }
      return true;
    });
  }, [rows, status, category, group, q]);

  /** 两套口径 */
  const paidRows = useMemo(
    () => filterByDate(baseRows, (r) => r.paidAt, paidStartYmd, paidEndYmd),
    [baseRows, paidStartYmd, paidEndYmd]
  );
  const payoutRows = useMemo(
    () => filterByDate(baseRows, (r) => r.payoutAt, payoutStartYmd, payoutEndYmd),
    [baseRows, payoutStartYmd, payoutEndYmd]
  );

  /** 明细列表：同时应用两套日期范围（用户填了就生效） */
  const listRows = useMemo(() => {
    let out = baseRows;
    out = filterByDate(out, (r) => r.paidAt, paidStartYmd, paidEndYmd);
    out = filterByDate(out, (r) => r.payoutAt, payoutStartYmd, payoutEndYmd);
    return out;
  }, [baseRows, paidStartYmd, paidEndYmd, payoutStartYmd, payoutEndYmd]);

  /** KPI */
  const kpi = useMemo(() => {
    const gmvUsd = paidRows.reduce((s, r) => s + (r.gmvUsd || 0), 0);
    const payoutCny = payoutRows.reduce((s, r) => s + (r.payoutCny || 0), 0);

    const totalCost = payoutRows.reduce(
      (s, r) => s + (r.payoutCny ? totalCostOf(r) : 0),
      0
    );
    const totalProfit = payoutRows.reduce((s, r) => s + profitOf(r), 0);
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
  }, [baseRows, listRows, paidRows, payoutRows, costMap, rowCostOverride]);

  /** 趋势 */
  const gmvSeries = useMemo(
    () => buildDailySeries(paidRows, (r) => r.paidAt, (r) => r.gmvUsd, paidStartYmd, paidEndYmd),
    [paidRows, paidStartYmd, paidEndYmd]
  );
  const payoutSeries = useMemo(
    () => buildDailySeries(payoutRows, (r) => r.payoutAt, (r) => r.payoutCny, payoutStartYmd, payoutEndYmd),
    [payoutRows, payoutStartYmd, payoutEndYmd]
  );
  const profitSeries = useMemo(
    () => buildDailySeries(payoutRows, (r) => r.payoutAt, (r) => profitOf(r), payoutStartYmd, payoutEndYmd),
    [payoutRows, payoutStartYmd, payoutEndYmd, costMap, rowCostOverride]
  );

  /** Top10：GMV/回款/利润 */
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
      profit: agg(payoutRows, (r) => profitOf(r)),
    };
  }, [paidRows, payoutRows, costMap, rowCostOverride]);

  /** Other 清单 */
  const otherRows = useMemo(() => {
    return baseRows.filter((r) => (r.titleGroup || "Other") === "Other").slice(0, 200);
  }, [baseRows]);

  /** ✅ 自动分析报告（核心） */
  const report = useMemo(() => {
    const topProfit = top10.profit[0];
    const topPayout = top10.payout[0];
    const topGmv = top10.gmv[0];

    const otherCount = baseRows.filter((r) => r.titleGroup === "Other").length;
    const otherRate = baseRows.length ? otherCount / baseRows.length : 0;

    const negProfitRows = payoutRows.filter((r) => r.payoutCny && profitOf(r) < 0);
    const negCount = negProfitRows.length;

    // 回款延迟：回款时间 - 付款时间（天）
    const lagDays = payoutRows
      .map((r) => {
        if (!r.paidAt || !r.payoutAt) return null;
        const d = (r.payoutAt.getTime() - r.paidAt.getTime()) / 86400000;
        return Number.isFinite(d) ? d : null;
      })
      .filter((x): x is number => x !== null);

    const lagAvg = lagDays.length ? lagDays.reduce((a, b) => a + b, 0) / lagDays.length : 0;
    const lagMed = median(lagDays);
    const lagP90 = percentile(lagDays, 0.9);

    // 回款状态分布（筛选后的 baseRows）
    const statusMap = new Map<string, number>();
    baseRows.forEach((r) => {
      const s = (r.payoutStatus || "未知").trim() || "未知";
      statusMap.set(s, (statusMap.get(s) ?? 0) + 1);
    });
    const statusTop = Array.from(statusMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);

    // 单条成本覆盖影响（只对 payoutRows 统计：有回款才有利润）
    const overrideKeys = Object.keys(rowCostOverride);
    const overrideCountAll = overrideKeys.length;

    let overrideCountInView = 0;
    let profitDeltaSum = 0; // (使用覆盖后的利润) - (默认利润)
    payoutRows.forEach((r) => {
      const id = rowId(r);
      if (Number.isFinite(rowCostOverride[id])) {
        overrideCountInView += 1;
        profitDeltaSum += profitOf(r) - profitOfDefault(r);
      }
    });

    const summary =
      `当前筛选：GMV(付款口径) $${money(kpi.gmvUsd)}；回款(回款口径) ¥${money(kpi.payoutCny)}；` +
      `利润 ¥${money(kpi.totalProfit)}（利润率 ${(kpi.margin * 100).toFixed(1)}%）。`;

    const highlights: string[] = [];
    if (topProfit) highlights.push(`利润Top1：${topProfit.group}（¥${money(topProfit.value)}）`);
    if (topPayout) highlights.push(`回款Top1：${topPayout.group}（¥${money(topPayout.value)}）`);
    if (topGmv) highlights.push(`GMV Top1：${topGmv.group}（$${money(topGmv.value)}）`);

    const risks: string[] = [];
    risks.push(`未识别 Other：${otherCount} 条（${(otherRate * 100).toFixed(1)}%）`);
    risks.push(`亏损单：${negCount} 条（回款<成本）`);
    if (lagDays.length) {
      risks.push(
        `回款延迟(天)：平均 ${lagAvg.toFixed(1)}；中位数 ${lagMed.toFixed(1)}；P90 ${lagP90.toFixed(1)}（样本 ${lagDays.length}）`
      );
    } else {
      risks.push("回款延迟：没有同时具备付款时间+回款时间的数据，无法统计");
    }

    const actions: string[] = [];
    if (otherRate >= 0.05) actions.push("Other 占比偏高：建议把 Other 清单里的关键词补进分类规则（提升可分析性）");
    if (negCount > 0) actions.push("存在亏损单：建议在订单明细里逐条校正成本（或检查标题分类是否误判）");
    if (lagDays.length && lagP90 >= 10) actions.push("回款延迟较长：建议按“回款状态”筛选，优先跟进未回款/异常状态");
    if (overrideCountInView > 0) {
      actions.push(
        `已对 ${overrideCountInView} 条回款单做了单条成本覆盖，利润影响合计 ${profitDeltaSum >= 0 ? "+" : ""}${money(profitDeltaSum, 2)} ¥`
      );
    } else {
      actions.push("如遇特殊成本：可在订单明细里用“单条成本¥/lot”覆盖，不影响分类默认成本");
    }

    const statusLine = statusTop.length
      ? `回款状态Top3：${statusTop.map(([s, c]) => `${s}(${c})`).join("、")}`
      : "回款状态Top3：无";

    const note =
      "口径说明：GMV 按【付款时间】筛选聚合；回款/利润按【回款时间】筛选聚合（两套时间范围互不影响）。";

    const copyText =
      `【自动分析报告】\n` +
      `${summary}\n` +
      `${statusLine}\n` +
      `\n亮点：\n- ${highlights.join("\n- ") || "暂无"}\n` +
      `\n风险：\n- ${risks.join("\n- ")}\n` +
      `\n建议：\n- ${actions.join("\n- ")}\n` +
      `\n${note}\n` +
      `单条成本覆盖：全局共 ${overrideCountAll} 条（本筛选视图内影响已统计）。`;

    return {
      summary,
      highlights,
      risks,
      actions,
      statusLine,
      note,
      copyText,
    };
  }, [top10, baseRows, payoutRows, kpi, rowCostOverride, costMap]);

  /** 明细：排序 + 分页 */
  const [sortKey, setSortKey] = useState<"profit" | "payout" | "gmv" | "lot">("profit");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [page, setPage] = useState(1);
  const pageSize = 50;

  useEffect(() => setPage(1), [status, category, group, q, paidStartYmd, paidEndYmd, payoutStartYmd, payoutEndYmd]);

  const sortedListRows = useMemo(() => {
    const arr = [...listRows];
    const val = (r: Row) => {
      if (sortKey === "profit") return profitOf(r);
      if (sortKey === "payout") return r.payoutCny || 0;
      if (sortKey === "gmv") return r.gmvUsd || 0;
      return lotCountOf(r);
    };
    arr.sort((a, b) => (val(a) - val(b)) * (sortDir === "asc" ? 1 : -1));
    return arr;
  }, [listRows, sortKey, sortDir, costMap, rowCostOverride]);

  const totalPages = Math.max(1, Math.ceil(sortedListRows.length / pageSize));
  const pagedRows = useMemo(
    () => sortedListRows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize),
    [sortedListRows, page]
  );

  const onCopyReport = async () => {
    try {
      await navigator.clipboard.writeText(report.copyText);
      alert("已复制分析报告 ✅");
    } catch {
      alert("复制失败：你的浏览器可能禁止剪贴板权限");
    }
  };

  return (
    <div style={{ background: "#f8fafc", minHeight: "100vh" }}>
      {/* 顶栏 */}
      <div style={{ position: "sticky", top: 0, zIndex: 10, background: "rgba(248,250,252,0.9)", backdropFilter: "blur(6px)", borderBottom: "1px solid #e2e8f0" }}>
        <div style={{ maxWidth: 1260, margin: "0 auto", padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: "#0f172a" }}>eBay Excel Dashboard</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button style={pill(tab === "overview")} onClick={() => setTab("overview")}>总览</button>
              <button style={pill(tab === "orders")} onClick={() => setTab("orders")}>订单明细</button>
              <button style={pill(tab === "costs")} onClick={() => setTab("costs")}>成本设置</button>
            </div>

            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <input type="file" accept=".xlsx,.xls" onChange={onFile} />
              <div style={smallStyle()}>{rows.length ? `已加载 ${rows.length.toLocaleString()} 行` : "先上传 Excel"}</div>
            </div>
          </div>
        </div>
      </div>

      {/* 主体：左筛选 + 右内容 */}
      <div style={{ maxWidth: 1260, margin: "0 auto", padding: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 14, alignItems: "start" }}>
          {/* 左：筛选 */}
          <div style={{ ...card(), ...cardPad(), position: "sticky", top: 78 }}>
            <div style={{ fontWeight: 900, color: "#0f172a" }}>筛选器</div>
            <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
              <label>
                <div style={smallStyle()}>付款时间范围（GMV）</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 6 }}>
                  <input type="date" value={paidStartYmd} onChange={(e) => setPaidStartYmd(e.target.value)} style={inputBase()} />
                  <input type="date" value={paidEndYmd} onChange={(e) => setPaidEndYmd(e.target.value)} style={inputBase()} />
                </div>
              </label>

              <label>
                <div style={smallStyle()}>回款时间范围（回款/利润）</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 6 }}>
                  <input type="date" value={payoutStartYmd} onChange={(e) => setPayoutStartYmd(e.target.value)} style={inputBase()} />
                  <input type="date" value={payoutEndYmd} onChange={(e) => setPayoutEndYmd(e.target.value)} style={inputBase()} />
                </div>
              </label>

              <label>
                <div style={smallStyle()}>回款状态</div>
                <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputBase()}>
                  {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>

              <label>
                <div style={smallStyle()}>类目（卡片类目）</div>
                <select value={category} onChange={(e) => setCategory(e.target.value)} style={inputBase()}>
                  {categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>

              <label>
                <div style={smallStyle()}>标题分类（titleGroup）</div>
                <select value={group} onChange={(e) => setGroup(e.target.value)} style={inputBase()}>
                  {groupOptions.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </label>

              <label>
                <div style={smallStyle()}>SKU / 标题搜索</div>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="输入关键字" style={inputBase()} />
              </label>

              <div style={{ display: "grid", gap: 6, marginTop: 4 }}>
                <div style={smallStyle()}>筛选后行数：{kpi.baseCount.toLocaleString()}</div>
                <div style={smallStyle()}>明细列表行数：{kpi.listCount.toLocaleString()}</div>
              </div>

              <button
                onClick={() => {
                  setPaidStartYmd(""); setPaidEndYmd("");
                  setPayoutStartYmd(""); setPayoutEndYmd("");
                  setStatus("全部"); setCategory("全部"); setGroup("全部"); setQ("");
                }}
                style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontWeight: 900 }}
              >
                清空筛选
              </button>
            </div>
          </div>

          {/* 右：内容 */}
          <div style={{ display: "grid", gap: 14 }}>
            {/* 总览 */}
            {tab === "overview" && (
              <>
                {/* KPI */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 12 }}>
                  <div style={{ ...card(), ...cardPad() }}>
                    <div style={smallStyle()}>GMV($)（付款口径）</div>
                    <div style={{ fontSize: 22, fontWeight: 900 }}>{money(kpi.gmvUsd)}</div>
                  </div>
                  <div style={{ ...card(), ...cardPad() }}>
                    <div style={smallStyle()}>回款(¥)（回款口径）</div>
                    <div style={{ fontSize: 22, fontWeight: 900 }}>{money(kpi.payoutCny)}</div>
                  </div>
                  <div style={{ ...card(), ...cardPad() }}>
                    <div style={smallStyle()}>成本合计(¥)（回款口径）</div>
                    <div style={{ fontSize: 22, fontWeight: 900 }}>{money(kpi.totalCost)}</div>
                  </div>
                  <div style={{ ...card(), ...cardPad() }}>
                    <div style={smallStyle()}>利润合计(¥)（回款-成本）</div>
                    <div style={{ fontSize: 22, fontWeight: 900 }}>{money(kpi.totalProfit)}</div>
                    <div style={smallStyle()}>{`利润率 ${(kpi.margin * 100).toFixed(1)}%`}</div>
                  </div>
                </div>

                {/* ✅ 自动分析报告 */}
                <div style={{ ...card(), ...cardPad() }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ fontWeight: 900 }}>自动分析报告</div>
                    <div style={smallStyle()}>{report.note}</div>
                    <button
                      onClick={onCopyReport}
                      style={{ marginLeft: "auto", padding: "8px 10px", borderRadius: 10, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontWeight: 900 }}
                    >
                      复制报告
                    </button>
                  </div>

                  <div style={{ marginTop: 10, fontWeight: 900 }}>{report.summary}</div>
                  <div style={{ marginTop: 6, ...smallStyle() }}>{report.statusLine}</div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 12, marginTop: 12 }}>
                    <div style={{ ...card(), padding: 12, background: "#fff" }}>
                      <div style={{ fontWeight: 900 }}>亮点</div>
                      <ul style={{ margin: "8px 0 0 18px", ...smallStyle() }}>
                        {(report.highlights.length ? report.highlights : ["暂无"]).map((x, i) => <li key={i}>{x}</li>)}
                      </ul>
                    </div>
                    <div style={{ ...card(), padding: 12, background: "#fff" }}>
                      <div style={{ fontWeight: 900 }}>风险</div>
                      <ul style={{ margin: "8px 0 0 18px", ...smallStyle() }}>
                        {report.risks.map((x, i) => <li key={i}>{x}</li>)}
                      </ul>
                    </div>
                    <div style={{ ...card(), padding: 12, background: "#fff" }}>
                      <div style={{ fontWeight: 900 }}>建议动作</div>
                      <ul style={{ margin: "8px 0 0 18px", ...smallStyle() }}>
                        {report.actions.map((x, i) => <li key={i}>{x}</li>)}
                      </ul>
                    </div>
                  </div>
                </div>

                {/* 图表二级选项：一次只显示一个 */}
                <div style={{ ...card(), ...cardPad() }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button style={pill(overviewView === "top10-gmv")} onClick={() => setOverviewView("top10-gmv")}>Top10 GMV</button>
                    <button style={pill(overviewView === "top10-payout")} onClick={() => setOverviewView("top10-payout")}>Top10 回款</button>
                    <button style={pill(overviewView === "top10-profit")} onClick={() => setOverviewView("top10-profit")}>Top10 利润</button>
                    <button style={pill(overviewView === "trend-gmv")} onClick={() => setOverviewView("trend-gmv")}>趋势 GMV</button>
                    <button style={pill(overviewView === "trend-payout")} onClick={() => setOverviewView("trend-payout")}>趋势 回款</button>
                    <button style={pill(overviewView === "trend-profit")} onClick={() => setOverviewView("trend-profit")}>趋势 利润</button>
                    <button style={pill(overviewView === "other")} onClick={() => setOverviewView("other")}>Other 清单</button>
                  </div>

                  <div style={{ marginTop: 12, width: "100%", height: 420 }}>
                    {overviewView === "top10-gmv" && (
                      <>
                        <div style={{ fontWeight: 900, marginBottom: 8 }}>分类 Top10（GMV $）</div>
                        <ResponsiveContainer>
                          <BarChart data={top10.gmv} layout="vertical" margin={{ left: 20, right: 20 }}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis type="number" />
                            <YAxis type="category" dataKey="group" width={170} />
                            <Tooltip />
                            <Bar dataKey="value" name="GMV($)" />
                          </BarChart>
                        </ResponsiveContainer>
                      </>
                    )}

                    {overviewView === "top10-payout" && (
                      <>
                        <div style={{ fontWeight: 900, marginBottom: 8 }}>分类 Top10（回款 ¥）</div>
                        <ResponsiveContainer>
                          <BarChart data={top10.payout} layout="vertical" margin={{ left: 20, right: 20 }}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis type="number" />
                            <YAxis type="category" dataKey="group" width={170} />
                            <Tooltip />
                            <Bar dataKey="value" name="回款(¥)" />
                          </BarChart>
                        </ResponsiveContainer>
                      </>
                    )}

                    {overviewView === "top10-profit" && (
                      <>
                        <div style={{ fontWeight: 900, marginBottom: 8 }}>分类 Top10（利润 ¥）</div>
                        <ResponsiveContainer>
                          <BarChart data={top10.profit} layout="vertical" margin={{ left: 20, right: 20 }}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis type="number" />
                            <YAxis type="category" dataKey="group" width={170} />
                            <Tooltip />
                            <Bar dataKey="value" name="利润(¥)" />
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
                            <Line type="monotone" dataKey="value" name="利润(¥)" stroke="#7c3aed" dot={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      </>
                    )}

                    {overviewView === "other" && (
                      <div style={{ height: "100%", display: "grid", gridTemplateRows: "auto 1fr" }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                          <div style={{ fontWeight: 900 }}>未识别（Other）清单</div>
                          <div style={smallStyle()}>{`最多显示 200，当前 ${otherRows.length}`}</div>
                          <button
                            onClick={() => setTab("orders")}
                            style={{ marginLeft: "auto", padding: "8px 10px", borderRadius: 10, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontWeight: 900 }}
                          >
                            去订单明细看全部 →
                          </button>
                        </div>

                        <div style={{ marginTop: 10, overflow: "auto", border: "1px solid #e2e8f0", borderRadius: 12 }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                            <thead>
                              <tr style={{ background: "#f1f5f9" }}>
                                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e2e8f0" }}>SKU</th>
                                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e2e8f0" }}>标题</th>
                                <th style={{ textAlign: "right", padding: 10, borderBottom: "1px solid #e2e8f0" }}>Lot</th>
                              </tr>
                            </thead>
                            <tbody>
                              {otherRows.map((r, idx) => (
                                <tr key={idx}>
                                  <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" }}>{r.sku}</td>
                                  <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9" }}>{r.name}</td>
                                  <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", textAlign: "right" }}>{lotCountOf(r)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>

                  <div style={{ marginTop: 8, ...smallStyle() }}>
                    说明：Top10 左侧文字截断已修复（YAxis 加宽），趋势日期也倾斜避免重叠。
                  </div>
                </div>
              </>
            )}

            {/* 订单明细（单条成本覆盖） */}
            {tab === "orders" && (
              <div style={{ ...card(), ...cardPad() }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 900 }}>订单明细（筛选后全部商品）</div>
                  <div style={smallStyle()}>{`共 ${sortedListRows.length.toLocaleString()} 条，每页 ${pageSize}`}</div>

                  <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <select value={sortKey} onChange={(e) => setSortKey(e.target.value as any)} style={{ ...inputBase(), width: 140 }}>
                      <option value="profit">按利润</option>
                      <option value="payout">按回款</option>
                      <option value="gmv">按GMV</option>
                      <option value="lot">按Lot数量</option>
                    </select>
                    <select value={sortDir} onChange={(e) => setSortDir(e.target.value as any)} style={{ ...inputBase(), width: 120 }}>
                      <option value="desc">从高到低</option>
                      <option value="asc">从低到高</option>
                    </select>
                  </div>
                </div>

                <div style={{ marginTop: 10, border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ overflow: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 1180 }}>
                      <thead>
                        <tr style={{ background: "#f1f5f9" }}>
                          <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e2e8f0" }}>titleGroup</th>
                          <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e2e8f0" }}>SKU</th>
                          <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e2e8f0" }}>标题</th>
                          <th style={{ textAlign: "right", padding: 10, borderBottom: "1px solid #e2e8f0" }}>Lot</th>

                          <th style={{ textAlign: "right", padding: 10, borderBottom: "1px solid #e2e8f0" }}>单条成本¥/lot（可改）</th>
                          <th style={{ textAlign: "right", padding: 10, borderBottom: "1px solid #e2e8f0" }}>默认成本¥/lot</th>

                          <th style={{ textAlign: "right", padding: 10, borderBottom: "1px solid #e2e8f0" }}>总成本¥</th>
                          <th style={{ textAlign: "right", padding: 10, borderBottom: "1px solid #e2e8f0" }}>回款¥</th>
                          <th style={{ textAlign: "right", padding: 10, borderBottom: "1px solid #e2e8f0" }}>利润¥</th>
                          <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e2e8f0" }}>回款状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pagedRows.map((r, idx) => {
                          const id = rowId(r);
                          const lot = lotCountOf(r);

                          const defaultC = costPerLotOfGroup(r.titleGroup);
                          const overrideVal = rowCostOverride[id];
                          const hasOverride = Number.isFinite(overrideVal);

                          const cTotal = totalCostOf(r);
                          const p = profitOf(r);

                          return (
                            <tr key={idx}>
                              <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" }}>{r.titleGroup}</td>
                              <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" }}>{r.sku}</td>
                              <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9" }}>{r.name}</td>
                              <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", textAlign: "right" }}>{lot}</td>

                              <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", textAlign: "right" }}>
                                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
                                  <input
                                    type="number"
                                    step="0.1"
                                    value={hasOverride ? String(overrideVal) : ""}
                                    placeholder={String(defaultC)}
                                    onChange={(e) => {
                                      const vStr = e.target.value;
                                      if (!vStr) {
                                        setRowCostOverride((prev) => {
                                          const next = { ...prev };
                                          delete next[id];
                                          return next;
                                        });
                                        return;
                                      }
                                      const v = Number(vStr);
                                      if (!Number.isFinite(v)) return;
                                      setRowCostOverride((prev) => ({ ...prev, [id]: v }));
                                    }}
                                    style={{
                                      width: 110,
                                      padding: "6px 8px",
                                      borderRadius: 10,
                                      border: "1px solid #e2e8f0",
                                      fontWeight: 800,
                                      background: hasOverride ? "#fff7ed" : "#fff",
                                    }}
                                    title="留空=用默认成本"
                                  />
                                  {hasOverride && (
                                    <button
                                      onClick={() => {
                                        setRowCostOverride((prev) => {
                                          const next = { ...prev };
                                          delete next[id];
                                          return next;
                                        });
                                      }}
                                      style={{
                                        padding: "6px 8px",
                                        borderRadius: 10,
                                        border: "1px solid #e2e8f0",
                                        background: "#fff",
                                        cursor: "pointer",
                                        fontWeight: 900,
                                        fontSize: 12,
                                      }}
                                      title="恢复默认成本"
                                    >
                                      恢复
                                    </button>
                                  )}
                                </div>
                                <div style={{ marginTop: 4, ...smallStyle(), textAlign: "right" }}>
                                  {hasOverride ? "已覆盖" : "使用默认"}
                                </div>
                              </td>

                              <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", textAlign: "right" }}>
                                {money(defaultC, 2)}
                              </td>

                              <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", textAlign: "right" }}>
                                {money(cTotal, 2)}
                              </td>

                              <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", textAlign: "right" }}>
                                {money(r.payoutCny)}
                              </td>

                              <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", textAlign: "right", fontWeight: 900 }}>
                                {r.payoutCny ? money(p) : "-"}
                              </td>

                              <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9" }}>{r.payoutStatus}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: 10, borderTop: "1px solid #e2e8f0", background: "#fff" }}>
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontWeight: 900 }}
                    >
                      上一页
                    </button>
                    <div style={smallStyle()}>{`第 ${page} / ${totalPages} 页`}</div>
                    <button
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontWeight: 900 }}
                    >
                      下一页
                    </button>
                  </div>
                </div>

                <div style={{ marginTop: 10, ...smallStyle() }}>
                  提示：单条成本输入框留空=恢复默认分类成本；修改后自动保存，刷新不丢。
                </div>
              </div>
            )}

            {/* 成本设置 */}
            {tab === "costs" && (
              <div style={{ ...card(), ...cardPad() }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 900 }}>成本设置（每 1 lot 成本，¥）</div>
                  <div style={smallStyle()}>修改会自动保存（分类默认成本）。</div>
                  <button
                    onClick={() => setCostMap({ ...COST_DEFAULTS })}
                    style={{ marginLeft: "auto", padding: "8px 10px", borderRadius: 10, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontWeight: 900 }}
                  >
                    恢复默认
                  </button>
                </div>

                <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
                  {costGroups.map((g) => (
                    <div key={g} style={{ ...card(), padding: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        <div style={{ fontWeight: 900 }}>{g}</div>
                        <div style={smallStyle()}>{`当前：${money(costMap[g] ?? 0, 2)} ¥/lot`}</div>
                      </div>

                      <div style={{ marginTop: 10 }}>
                        <input
                          type="number"
                          step="0.1"
                          value={String(costMap[g] ?? 0)}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setCostMap((prev) => ({ ...prev, [g]: Number.isFinite(v) ? v : 0 }));
                          }}
                          style={{ width: "100%", padding: 10, borderRadius: 12, border: "1px solid #e2e8f0", fontWeight: 900 }}
                        />
                        <div style={{ marginTop: 8, ...smallStyle() }}>
                          {`举例：100 Lot -> 成本 ${money((costMap[g] ?? 0) * 100, 2)} ¥`}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 12, ...smallStyle() }}>
                  说明：订单明细里可以对单条商品覆盖成本（¥/lot），那种覆盖不会影响这里的分类默认成本。
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

