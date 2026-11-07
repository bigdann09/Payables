import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const USDC_DECIMALS = 6;
const SCALE = BigInt(10 ** USDC_DECIMALS);

function toBig(v: string | number | bigint | null | undefined): bigint {
  if (v === null || v === undefined || v === "") return BigInt(0);
  try {
    return BigInt(typeof v === "number" ? Math.trunc(v) : v);
  } catch {
    return BigInt(0);
  }
}

/** "1500000000" -> "1,500.00" */
export function formatUsdc(
  base: string | number | bigint | null | undefined,
  opts: { decimals?: number; compact?: boolean } = {},
): string {
  const v = toBig(base);
  const neg = v < BigInt(0);
  const abs = neg ? -v : v;
  const whole = abs / SCALE;
  const frac = abs % SCALE;
  if (opts.compact && whole >= BigInt(10000)) {
    const n = Number(whole);
    const s = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
    return (neg ? "-" : "") + s;
  }
  const d = opts.decimals ?? 2;
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").slice(0, d);
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + wholeStr + (d > 0 ? "." + fracStr : "");
}

/** "1,500.5" -> "1500500000". Returns null on invalid input. */
export function parseUsdc(input: string): string | null {
  const s = input.replace(/[,\s]/g, "").replace(/^\$/, "");
  if (!/^\d+(\.\d{0,6})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  return (BigInt(w) * SCALE + BigInt(f.padEnd(USDC_DECIMALS, "0") || "0")).toString();
}

/** Plain decimal string for inputs: "1500000000" -> "1500" */
export function usdcToInput(base: string | null | undefined): string {
  const v = toBig(base);
  const whole = v / SCALE;
  const frac = (v % SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function ratio(a: string, b: string): number {
  const bb = toBig(b);
  if (bb === BigInt(0)) return 0;
  return Number((toBig(a) * BigInt(10000)) / bb) / 10000;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return formatDate(iso);
}

export function shortHash(h: string | null | undefined, n = 6): string {
  if (!h) return "";
  return h.length <= n * 2 + 1 ? h : `${h.slice(0, n)}…${h.slice(-n)}`;
}

export const EXPLORER_TX = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
export const EXPLORER_ACCOUNT = (id: string) => `https://testnet.nearblocks.io/address/${id}`;
export const DAO_PROPOSAL_URL = (daoId: string, proposalId: string | number) =>
  `https://testnet.app.astrodao.com/dao/${daoId}/proposals/${daoId}-${proposalId}`;

export const NEAR_ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export function isValidNearAccount(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && NEAR_ACCOUNT_RE.test(id);
}
