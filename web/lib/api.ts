// Typed REST client for the Payables API (SPEC.md). Falls back to the in-browser mock backend when the API
// is unreachable or NEXT_PUBLIC_USE_MOCKS=true.
import { mock } from "./mock-store";
import type {
  ActivityLog,
  AttackInfo,
  AttackRun,
  Company,
  FlaggedAddress,
  CompanyPatch,
  Invoice,
  InvoiceDetail,
  InvoiceStatus,
  Payee,
  PayeeCreate,
  PayeePatch,
  PurchaseOrder,
  PurchaseOrderCreate,
  Stats,
} from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api").replace(/\/$/, "");
const FORCE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS === "true";
const COMPANY_ID = process.env.NEXT_PUBLIC_COMPANY_ID;
const TIMEOUT_MS = 4000;
const RETRY_AFTER_MS = 15_000;

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
  }
}
class Unreachable extends Error {}

// ---- data-source state (observable for the "mock data" badge) ----
type Source = "unknown" | "api" | "mock";
let source: Source = FORCE_MOCKS ? "mock" : "unknown";
let downUntil = 0;
const subs = new Set<() => void>();
function setSource(s: Source) {
  if (s !== source) {
    source = s;
    subs.forEach((f) => f());
  }
}
export const dataSource = {
  get: () => source,
  subscribe: (f: () => void) => {
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  },
  forced: FORCE_MOCKS,
};

function unwrap<T>(json: unknown): T {
  // Tolerate `{ data: ... }` / `{ items: [...] }` envelopes.
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const o = json as Record<string, unknown>;
    if ("data" in o && Object.keys(o).length <= 3) return o.data as T;
    if (Array.isArray(o.items)) return o.items as T;
  }
  return json as T;
}

async function http<T>(path: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = new Headers(init.headers);
  if (COMPANY_ID) headers.set("x-company-id", COMPANY_ID);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers, signal: ctrl.signal, cache: "no-store" });
  } catch (e) {
    throw new Unreachable(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const msg =
      (json && typeof json === "object" && "message" in json
        ? Array.isArray((json as { message: unknown }).message)
          ? ((json as { message: string[] }).message).join(", ")
          : String((json as { message: unknown }).message)
        : null) || `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status, json);
  }
  return unwrap<T>(json);
}

async function call<T>(real: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  if (FORCE_MOCKS || typeof window === "undefined") {
    if (typeof window !== "undefined") setSource("mock");
    return fallback();
  }
  if (Date.now() < downUntil) return fallback();
  try {
    const r = await real();
    setSource("api");
    return r;
  } catch (e) {
    if (e instanceof Unreachable) {
      downUntil = Date.now() + RETRY_AFTER_MS;
      setSource("mock");
      return fallback();
    }
    throw e;
  }
}

const json = (body: unknown) => JSON.stringify(body);

/** Red team talks to the live API only: a mocked "on-chain refusal" would be fake evidence. */
const live = async <T,>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Unreachable) throw new ApiError("The Payables API is offline right now, so red team can't reach the contract.", 0);
    throw e;
  }
};
const ATTACK_TIMEOUT = 60_000;

export const attackApi = {
  info: () => live(() => http<AttackInfo>("/attack")),
  preset: (id: string) => live(() => http<AttackRun>(`/attack/preset/${encodeURIComponent(id)}`, { method: "POST" }, ATTACK_TIMEOUT)),
  direct: (account: string, amount: string) =>
    live(() => http<AttackRun>("/attack/direct", { method: "POST", body: json({ account, amount }) }, ATTACK_TIMEOUT)),
  upload: (file: File) =>
    live(() => {
      const fd = new FormData();
      fd.append("file", file);
      return http<AttackRun>("/attack/upload", { method: "POST", body: fd }, ATTACK_TIMEOUT);
    }),
};

export const api = {
  getCompany: () => call<Company>(() => http("/company"), mock.getCompany),
  patchCompany: (patch: CompanyPatch) =>
    call<Company>(() => http("/company", { method: "PATCH", body: json(patch) }), () => mock.patchCompany(patch)),
  getStats: () => call<Stats>(() => http("/stats"), mock.getStats),
  listInvoices: (status?: InvoiceStatus) =>
    call<Invoice[]>(
      () => http(`/invoices${status ? `?status=${encodeURIComponent(status)}` : ""}`),
      () => mock.listInvoices(status),
    ),
  getInvoice: (id: string) => call<InvoiceDetail>(() => http(`/invoices/${encodeURIComponent(id)}`), () => mock.getInvoice(id)),
  uploadInvoice: (file: File, payeeId?: string) =>
    call<Invoice>(
      () => {
        const fd = new FormData();
        fd.append("file", file);
        if (payeeId) fd.append("payeeId", payeeId);
        return http("/invoices", { method: "POST", body: fd });
      },
      () => mock.uploadInvoice(file, payeeId),
    ),
  /** `force` sends a blocked invoice to the contract anyway, to demo the on-chain refusal. */
  payNow: (id: string, force = false) =>
    call<Invoice>(
      () => http(`/invoices/${encodeURIComponent(id)}/pay-now`, { method: "POST", body: json(force ? { force: true } : {}) }),
      () => mock.payNow(id),
    ),
  listPayees: () => call<Payee[]>(() => http("/payees"), mock.listPayees),
  createPayee: (input: PayeeCreate) =>
    call<Payee>(() => http("/payees", { method: "POST", body: json(input) }), () => mock.createPayee(input)),
  patchPayee: (id: string, patch: PayeePatch) =>
    call<Payee>(
      () => http(`/payees/${encodeURIComponent(id)}`, { method: "PATCH", body: json(patch) }),
      () => mock.patchPayee(id, patch),
    ),
  listPurchaseOrders: () => call<PurchaseOrder[]>(() => http("/purchase-orders"), mock.listPurchaseOrders),
  createPurchaseOrder: (input: PurchaseOrderCreate) =>
    call<PurchaseOrder>(
      () => http("/purchase-orders", { method: "POST", body: json(input) }),
      () => mock.createPurchaseOrder(input),
    ),
  listFlagged: () => call<FlaggedAddress[]>(() => http("/flagged-addresses"), mock.listFlagged),
  listActivity: () => call<ActivityLog[]>(() => http("/activity"), mock.listActivity),
  /** Demo scenario 4 without a real DAO vote. The API only exposes this route on its simulated chain. */
  simulateDaoApproval: (id: string) =>
    call<void>(
      () => http(`/dev/dao/invoices/${encodeURIComponent(id)}/approve`, { method: "POST" }),
      () => mock.simulateDaoApproval(id),
    ),
};
