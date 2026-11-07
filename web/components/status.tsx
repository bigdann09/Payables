import { AlertOctagon, AlertTriangle, Info } from "lucide-react";
import { cn, formatUsdc } from "@/lib/format";
import type { InvoiceStatus, PayeeStatus, RiskFlag, RiskSeverity } from "@/lib/types";

type Tone = "neutral" | "info" | "ok" | "warn" | "danger" | "violet" | "accent";

const toneClass: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted border-border",
  info: "bg-info-soft text-info border-info/20",
  ok: "bg-ok-soft text-ok border-ok/20",
  warn: "bg-warn-soft text-warn border-warn/25",
  danger: "bg-danger-soft text-danger border-danger/25",
  violet: "bg-violet-soft text-violet border-violet/25",
  accent: "bg-accent-soft text-accent border-accent/25",
};
const dotClass: Record<Tone, string> = {
  neutral: "bg-faint",
  info: "bg-info",
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  violet: "bg-violet",
  accent: "bg-accent",
};

export function Pill({ tone = "neutral", children, dot, pulse, className }: { tone?: Tone; children: React.ReactNode; dot?: boolean; pulse?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11.5px] font-medium leading-4", toneClass[tone], className)}>
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full", dotClass[tone], pulse && "pulse-dot")} />}
      {children}
    </span>
  );
}

export const STATUS_META: Record<InvoiceStatus, { label: string; tone: Tone; live?: boolean; description: string }> = {
  received: { label: "Received", tone: "neutral", live: true, description: "PDF uploaded, queued for extraction." },
  extracting: { label: "Extracting", tone: "info", live: true, description: "The agent is reading the invoice." },
  needs_review: { label: "Needs review", tone: "warn", description: "Rule checks raised warnings. A human should look before scheduling." },
  blocked: { label: "Blocked", tone: "danger", description: "A blocking risk flag stopped this invoice. No payment will be requested." },
  scheduled: { label: "Scheduled", tone: "accent", description: "All checks passed. The agent will pay on the due date." },
  paying: { label: "Paying", tone: "info", live: true, description: "request_payment submitted to the policy contract." },
  pending_approval: { label: "Awaiting DAO", tone: "violet", live: true, description: "Over policy. The contract opened a DAO proposal; payment releases on approval." },
  paid: { label: "Paid", tone: "ok", description: "USDC transferred on NEAR testnet." },
  failed: { label: "Failed", tone: "danger", description: "The on-chain transfer failed or the contract refused it." },
  rejected: { label: "Rejected", tone: "neutral", description: "The DAO or owner rejected this payment." },
};

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  const m = STATUS_META[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <Pill tone={m.tone} dot pulse={m.live}>
      {m.label}
    </Pill>
  );
}

export function PayeeStatusBadge({ status }: { status: PayeeStatus }) {
  return status === "active" ? (
    <Pill tone="ok" dot>
      Allowlisted
    </Pill>
  ) : (
    <Pill tone="violet" dot pulse>
      Change pending DAO
    </Pill>
  );
}

export const SEVERITY_META: Record<RiskSeverity, { tone: Tone; label: string; Icon: typeof Info }> = {
  info: { tone: "info", label: "Info", Icon: Info },
  warn: { tone: "warn", label: "Warning", Icon: AlertTriangle },
  block: { tone: "danger", label: "Blocking", Icon: AlertOctagon },
};

export const RISK_LABEL: Record<string, string> = {
  PAYEE_MISMATCH: "Payee mismatch",
  AMOUNT_EXCEEDS_PO: "Exceeds PO",
  NO_PO: "No PO",
  DUPLICATE_HASH: "Duplicate PDF",
  DUPLICATE_NUMBER: "Duplicate number",
  PROMPT_INJECTION: "Prompt injection",
  OVER_LIMIT: "Over limit",
};

export function RiskChips({ flags, max = 2 }: { flags: RiskFlag[] | null | undefined; max?: number }) {
  const list = [...(flags ?? [])].sort((a, b) => sevRank(b.severity) - sevRank(a.severity));
  if (!list.length) return <span className="text-xs text-faint">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {list.slice(0, max).map((f) => (
        <Pill key={f.code} tone={SEVERITY_META[f.severity]?.tone ?? "neutral"} className="rounded-md px-1.5 text-[11px]">
          {RISK_LABEL[f.code] ?? f.code}
        </Pill>
      ))}
      {list.length > max && <span className="self-center text-[11px] text-muted">+{list.length - max}</span>}
    </span>
  );
}

export function sevRank(s: RiskSeverity) {
  return s === "block" ? 3 : s === "warn" ? 2 : 1;
}

export function Amount({ value, className, unit = true }: { value: string | null | undefined; className?: string; unit?: boolean }) {
  return (
    <span className={cn("num whitespace-nowrap", className)}>
      {formatUsdc(value)}
      {unit && <span className="ml-1 text-[0.8em] text-muted">USDC</span>}
    </span>
  );
}
