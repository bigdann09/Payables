"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Check, ExternalLink, Loader2, X } from "lucide-react";
import { Card, LinkButton, Skeleton } from "@/components/ui";
import { Amount, RISK_LABEL, StatusBadge } from "@/components/status";
import { useInvoice, usePayees } from "@/lib/hooks";
import { cn, EXPLORER_TX, formatDate, shortHash } from "@/lib/format";
import type { InvoiceDetail } from "@/lib/types";

type StepState = "done" | "active" | "todo" | "error" | "waiting";

function steps(inv: InvoiceDetail): { label: string; detail: string; state: StepState }[] {
  const s = inv.status;
  const order = ["received", "extracting", "checks", "payment", "paid"];
  const pos =
    s === "received" ? 0 : s === "extracting" ? 1 : ["needs_review", "blocked"].includes(s) ? 2 : ["scheduled", "paying", "pending_approval", "failed", "rejected"].includes(s) ? 3 : 4;
  const st = (i: number): StepState => (i < pos ? "done" : i === pos ? "active" : "todo");
  const out = [
    { label: "Received", detail: "Your PDF was uploaded securely.", state: st(0) },
    { label: "Reading invoice", detail: "Extracting invoice number, amount, due date and PO.", state: st(1) },
    { label: "Checks", detail: "Matched against your registered account and Acme's purchase orders.", state: st(2) },
    { label: "Payment", detail: "Submitted to Acme's on-chain payment policy.", state: st(3) },
    { label: "Paid", detail: "USDC arrived in your NEAR account.", state: st(4) },
  ];
  void order;
  if (s === "paid") out[4].state = "done";
  if (s === "needs_review") out[2] = { ...out[2], state: "waiting", detail: "Acme's finance team is reviewing this invoice." };
  if (s === "blocked") out[2] = { ...out[2], state: "error", detail: "This invoice couldn't be approved automatically. Acme has been notified." };
  if (s === "scheduled") out[3] = { ...out[3], state: "waiting", detail: `Scheduled for the due date, ${formatDate(inv.dueDate)}.` };
  if (s === "pending_approval") out[3] = { ...out[3], state: "waiting", detail: "Above Acme's auto-pay limit — awaiting approval by their DAO." };
  if (s === "failed") out[3] = { ...out[3], state: "error", detail: "The transfer failed. Acme has been notified and will retry." };
  if (s === "rejected") out[3] = { ...out[3], state: "error", detail: "Acme declined this payment. Contact them for details." };
  return out;
}

function StepIcon({ state }: { state: StepState }) {
  return (
    <span
      className={cn(
        "z-10 grid h-7 w-7 shrink-0 place-items-center rounded-full border text-xs",
        state === "done" && "border-ok bg-ok text-white dark:text-black",
        state === "active" && "border-info bg-info-soft text-info",
        state === "waiting" && "border-violet bg-violet-soft text-violet",
        state === "error" && "border-danger bg-danger-soft text-danger",
        state === "todo" && "border-border bg-surface text-faint",
      )}
    >
      {state === "done" ? (
        <Check className="h-3.5 w-3.5" />
      ) : state === "error" ? (
        <X className="h-3.5 w-3.5" />
      ) : state === "active" || state === "waiting" ? (
        <Loader2 className={cn("h-3.5 w-3.5", state === "active" && "animate-spin")} />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
      )}
    </span>
  );
}

export function PortalStatus() {
  const { id } = useParams<{ id: string }>();
  const { data: inv, error } = useInvoice(id);
  const { data: payees } = usePayees();

  if (error && !inv)
    return (
      <Card className="p-6 text-center">
        <p className="font-medium">We couldn&apos;t find that invoice.</p>
        <p className="mt-1 text-sm text-muted">{error instanceof Error ? error.message : String(error)}</p>
        <div className="mt-4">
          <LinkButton href="/portal">Upload an invoice</LinkButton>
        </div>
      </Card>
    );

  if (!inv)
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-72" />
      </div>
    );

  const payee = inv.payee ?? payees?.find((p) => p.id === inv.payeeId);
  const list = steps(inv);
  const reasons = (inv.riskFlags ?? []).filter((f) => f.severity !== "info");

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs text-muted">Invoice status · updates automatically</p>
          <h1 className="num mt-1 text-2xl font-semibold tracking-tight">{inv.extracted ? inv.number : "Processing…"}</h1>
          {payee && <p className="mt-1 text-sm text-muted">{payee.name}</p>}
        </div>
        <div className="flex flex-col items-start gap-1.5 sm:items-end">
          {inv.amount !== "0" && <Amount value={inv.amount} className="text-2xl font-semibold" />}
          <StatusBadge status={inv.status} />
        </div>
      </div>

      <Card className="p-5 sm:p-6">
        <ol>
          {list.map((s, i) => (
            <li key={s.label} className="relative flex gap-4 pb-6 last:pb-0">
              {i < list.length - 1 && <span className={cn("absolute left-[13px] top-7 bottom-0 w-px", s.state === "done" ? "bg-ok" : "bg-border")} />}
              <StepIcon state={s.state} />
              <div className="pt-0.5">
                <div className={cn("text-sm font-medium", s.state === "todo" && "text-faint")}>{s.label}</div>
                {s.state !== "todo" && <p className="mt-0.5 text-[13px] text-muted">{s.detail}</p>}
                {s.label === "Checks" && s.state === "error" && reasons.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {reasons.map((r) => (
                      <li key={r.code} className="text-[13px] text-danger">
                        · {RISK_LABEL[r.code] ?? r.code}
                      </li>
                    ))}
                  </ul>
                )}
                {s.label === "Paid" && s.state === "done" && inv.txHash && (
                  <a href={EXPLORER_TX(inv.txHash)} target="_blank" rel="noreferrer" className="num mt-1 inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline">
                    {shortHash(inv.txHash, 8)} <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <div className="flex flex-wrap gap-3 text-sm">
        <Link href="/portal" className="font-medium text-accent hover:underline">
          Submit another invoice
        </Link>
        <span className="text-faint">·</span>
        <Link href={`/dashboard/invoices/${inv.id}`} className="text-muted hover:text-fg">
          View as Acme (demo)
        </Link>
      </div>
    </div>
  );
}
