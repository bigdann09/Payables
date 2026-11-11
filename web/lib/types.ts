// Types mirroring SPEC.md (REST API, Prisma models). Amounts are USDC base-unit strings (6 decimals).

export type InvoiceStatus =
  | "received"
  | "extracting"
  | "needs_review"
  | "blocked"
  | "scheduled"
  | "paying"
  | "pending_approval"
  | "paid"
  | "failed"
  | "rejected";

export const INVOICE_STATUSES: InvoiceStatus[] = [
  "received",
  "extracting",
  "needs_review",
  "blocked",
  "scheduled",
  "paying",
  "pending_approval",
  "paid",
  "failed",
  "rejected",
];

export type RiskSeverity = "info" | "warn" | "block";

export type RiskCode =
  | "PAYEE_MISMATCH"
  | "AMOUNT_EXCEEDS_PO"
  | "NO_PO"
  | "DUPLICATE_HASH"
  | "DUPLICATE_NUMBER"
  | "PROMPT_INJECTION"
  | "OVER_LIMIT";

export interface RiskFlag {
  code: RiskCode;
  severity: RiskSeverity;
  message: string;
}

export interface LineItem {
  description: string;
  quantity?: number;
  unitPrice?: string;
  amount: string;
}

/** Zod-validated extraction output from the `extract` worker. */
export interface ExtractedInvoice {
  invoiceNumber?: string;
  payeeName?: string;
  payeeNearAccount?: string;
  amount?: string;
  currency?: string;
  dueDate?: string;
  poNumber?: string | null;
  lineItems?: LineItem[];
}

export interface Company {
  id: string;
  name: string;
  policyContractId: string;
  daoId: string;
  autoPayLimit: string;
  dailyCap: string;
  telegramChatId?: string | null;
  notifyEmail?: string | null;
  /** On-chain config (GET /company "Company settings + on-chain config"). Shape not fixed by SPEC; all optional. */
  onChain?: {
    owner_id?: string;
    agent_id?: string;
    dao_id?: string;
    usdc_id?: string;
    auto_pay_limit?: string;
    daily_cap?: string;
  } | null;
  /** Which integrations are live vs mocked on the API side. `chain: "simulated"` enables the dev DAO routes. */
  integrations?: {
    chain?: string;
    storage?: string;
    extractor?: string;
    telegram?: string;
    email?: string;
  };
}

export interface CompanyPatch {
  autoPayLimit?: string;
  dailyCap?: string;
  telegramChatId?: string | null;
  notifyEmail?: string | null;
}

export interface Stats {
  treasuryBalance: string;
  paidThisMonth: string;
  pendingApprovals: number;
  blockedCount: number;
  dailySpent: string;
  dailyCap: string;
}

export type PayeeStatus = "active" | "pending_change";

export interface Payee {
  id: string;
  companyId: string;
  name: string;
  email: string;
  nearAccountId: string;
  status: PayeeStatus;
  /** Requested account while status = pending_change */
  pendingNearAccountId?: string | null;
  pendingChangeProposalId?: string | null;
  createdAt: string;
}

export interface PayeeCreate {
  name: string;
  email: string;
  nearAccountId: string;
  /** Override the flagged-address warning (account was targeted by a blocked invoice or attack). */
  acknowledgeFlag?: boolean;
}

export interface PayeePatch {
  name?: string;
  email?: string;
  nearAccountId?: string;
  acknowledgeFlag?: boolean;
}

/** An account a blocked invoice or red-team attack tried to get paid. */
export interface FlaggedAddress {
  id: string;
  account: string;
  reason: string;
  source: "invoice" | "attack";
  amount?: string | null;
  invoiceId?: string | null;
  hits: number;
  firstSeen: string;
  lastSeen: string;
}

export type PoStatus = "open" | "closed";

export interface PurchaseOrder {
  id: string;
  companyId: string;
  payeeId: string;
  number: string;
  amount: string;
  description: string;
  status: PoStatus;
  /** Not in SPEC; tolerated if the API includes the relation. */
  payee?: Payee | null;
}

export interface PurchaseOrderCreate {
  payeeId: string;
  number: string;
  amount: string;
  description: string;
}

export interface ActivityLog {
  id: string;
  companyId: string;
  invoiceId?: string | null;
  type: string;
  message: string;
  data?: Record<string, unknown> | null;
  createdAt: string;
}

export interface Invoice {
  id: string;
  companyId: string;
  payeeId?: string | null;
  poId?: string | null;
  number: string;
  amount: string;
  currency: string;
  dueDate: string;
  pdfKey: string;
  pdfHash: string;
  extracted: ExtractedInvoice | null;
  riskFlags: RiskFlag[] | null;
  status: InvoiceStatus;
  txHash?: string | null;
  daoProposalId?: string | number | null;
  createdAt: string;
  /** Relations — optional; the UI falls back to looking them up by id. */
  payee?: Payee | null;
  po?: PurchaseOrder | null;
}

export interface InvoiceDetail extends Invoice {
  pdfUrl?: string | null;
  activity?: ActivityLog[];
}

// ---- Red team (/red-team)
export type AttackStepStatus = "pass" | "block" | "skip" | "info" | "error";
export interface AttackStep {
  key: "received" | "extract" | "rules" | "agent" | "contract" | "flagged";
  title: string;
  status: AttackStepStatus;
  detail: string;
  data?: Record<string, unknown>;
  txHash?: string;
  explorerUrl?: string;
}
export interface AttackRun {
  id: string;
  scenario: string;
  verdict: "refused_on_chain" | "blocked_offchain" | "not_submitted";
  headline: string;
  steps: AttackStep[];
  at: string;
}
export interface AttackInfo {
  presets: { id: string; title: string; blurb: string }[];
  contract: string;
  agent: string;
  network: string;
  extractor: string;
  limits: { perIpPer10Min: number; uploadsLeftToday: number };
  stats: { runs: number; refusedOnChain: number };
  recent: AttackRun[];
  flagged: FlaggedAddress[];
}

/** "Try a sample" invoice offered in the contractor portal. */
export interface SampleInvoice {
  id: "clean" | "tampered" | "injection" | "over-limit";
  title: string;
  expected: string;
}

export interface SampleList {
  samples: SampleInvoice[];
  autoPayLimit: string | null;
  leftToday: number;
}
