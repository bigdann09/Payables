"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, Check, Copy, ExternalLink, FileText, Landmark, ShieldCheck, Zap } from "lucide-react";
import { Button, Card, CardHeader, Dialog, EmptyState, ErrorNote, LinkButton, Mono, Skeleton } from "@/components/ui";
import { Amount, Pill, RISK_LABEL, SEVERITY_META, STATUS_META, StatusBadge, sevRank } from "@/components/status";
import { Timeline } from "@/components/activity-feed";
import { payeeName } from "@/components/invoice-table";
import { api } from "@/lib/api";
import { useCompany, useDataSource, useInvoice, usePayees, usePurchaseOrders, useRefreshAll } from "@/lib/hooks";
import { DaoVote } from "@/components/dao-vote";
import { cn, DAO_PROPOSAL_URL, EXPLORER_ACCOUNT, EXPLORER_TX, formatDate, formatDateTime, formatUsdc, shortHash } from "@/lib/format";
import type { InvoiceDetail, RiskFlag } from "@/lib/types";

function CopyButton({ value }: { value: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }}
      className="rounded p-0.5 text-faint hover:text-fg"
      aria-label="Copy"
    >
      {ok ? <Check className="h-3 w-3 text-ok" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function Row({ label, children, mono, highlight }: { label: string; children: React.ReactNode; mono?: boolean; highlight?: "danger" | "warn" }) {
  return (
    <div className={cn("grid grid-cols-[130px_1fr] gap-3 px-4 py-2 text-[13px]", highlight === "danger" && "bg-danger-soft/60", highlight === "warn" && "bg-warn-soft/60")}>
      <dt className="text-muted">{label}</dt>
      <dd className={cn("min-w-0 break-words", mono && "num text-[12.5px]", highlight === "danger" && "text-danger font-medium")}>{children ?? <span className="text-faint">—</span>}</dd>
    </div>
  );
}

function RiskFlagItem({ flag }: { flag: RiskFlag }) {
  const m = SEVERITY_META[flag.severity] ?? SEVERITY_META.info;
  const Icon = m.Icon;
  return (
    <li
      className={cn(
        "flex gap-3 border-l-[3px] px-4 py-3",
        flag.severity === "block" && "border-l-danger bg-danger-soft/50",
        flag.severity === "warn" && "border-l-warn bg-warn-soft/40",
        flag.severity === "info" && "border-l-info bg-info-soft/40",
      )}
    >
      <Icon
        className={cn("mt-0.5 h-4 w-4 shrink-0", flag.severity === "block" ? "text-danger" : flag.severity === "warn" ? "text-warn" : "text-info")}
      />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold">{RISK_LABEL[flag.code] ?? flag.code}</span>
          <span className="num text-[11px] text-faint">{flag.code}</span>
          <Pill tone={m.tone} className="rounded-md px-1.5 text-[10.5px] uppercase tracking-wide">
            {m.label}
          </Pill>
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">{flag.message}</p>
      </div>
    </li>
  );
}

function PayNowDialog({ inv, open, onClose, onDone }: { inv: InvoiceDetail; open: boolean; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const blocking = (inv.riskFlags ?? []).filter((f) => f.severity === "block");
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Pay now"
      description="Enqueue the pay job immediately instead of waiting for the due date."
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={blocking.length ? "danger" : "primary"}
            size="sm"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await api.payNow(inv.id, blocking.length > 0);
                onDone();
                onClose();
              } catch (e) {
                setErr(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Zap className="h-3.5 w-3.5" /> {blocking.length ? "Force request_payment" : "Request payment"}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between rounded-md border border-border bg-surface-2 px-3 py-2.5">
          <span className="text-muted">{inv.number}</span>
          <Amount value={inv.amount} className="font-semibold" />
        </div>
        <p className="text-muted">
          The agent will call <Mono>request_payment</Mono> on the policy contract. The contract, not the agent, decides: at or under the auto-pay limit it transfers USDC; above it, it opens a DAO proposal.
        </p>
        {blocking.length > 0 && (
          <div className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
            <b>This invoice is blocked</b> ({blocking.map((f) => RISK_LABEL[f.code] ?? f.code).join(", ")}). Forcing it demonstrates the on-chain guard: the contract rejects any payee that is not allowlisted.
          </div>
        )}
        <ErrorNote error={err} />
      </div>
    </Dialog>
  );
}

export function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: inv, error, isLoading, mutate } = useInvoice(id);
  const { data: payees } = usePayees();
  const { data: pos } = usePurchaseOrders();
  const { data: company } = useCompany();
  const source = useDataSource();
  const refreshAll = useRefreshAll();
  const [payOpen, setPayOpen] = useState(false);
  const [approving, setApproving] = useState(false);


  if (error && !inv)
    return (
      <div className="space-y-4">
        <BackLink />
        <Card>
          <EmptyState title="Invoice not found" description={error instanceof Error ? error.message : String(error)} />
        </Card>
      </div>
    );

  if (isLoading || !inv)
    return (
      <div className="space-y-4">
        <BackLink />
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
        </div>
      </div>
    );

  const payee = inv.payee ?? payees?.find((p) => p.id === inv.payeeId) ?? null;
  const po = inv.po ?? pos?.find((p) => p.id === inv.poId) ?? null;
  const ex = inv.extracted ?? {};
  const flags = [...(inv.riskFlags ?? [])].sort((a, b) => sevRank(b.severity) - sevRank(a.severity));
  const accountMismatch = !!(ex.payeeNearAccount && payee && ex.payeeNearAccount !== payee.nearAccountId) || flags.some((f) => f.code === "PAYEE_MISMATCH");
  const meta = STATUS_META[inv.status];
  const canPay = !["paid", "paying", "pending_approval", "rejected", "received", "extracting"].includes(inv.status);
  const daoId = company?.daoId;
  const poDelta = po ? BigInt(inv.amount || "0") - BigInt(po.amount) : null;
  const activity = inv.activity ?? [];

  return (
    <div className="space-y-5">
      <BackLink />

      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="num text-xl font-semibold tracking-tight">{inv.number}</h1>
            <StatusBadge status={inv.status} />
          </div>
          <div className="mt-1 text-sm text-muted">
            {payeeName(inv, payees)} · due {formatDate(inv.dueDate)} · received {formatDateTime(inv.createdAt)}
          </div>
        </div>
        <div className="flex flex-col items-start gap-3 lg:items-end">
          <Amount value={inv.amount} className="text-[28px] font-semibold tracking-tight" />
          <div className="flex flex-wrap gap-2">
            {inv.pdfUrl && (
              <LinkButton href={inv.pdfUrl} external variant="secondary" size="sm">
                <FileText className="h-3.5 w-3.5" /> View PDF
              </LinkButton>
            )}
            {inv.status === "pending_approval" && inv.daoProposalId != null && daoId && (
              <LinkButton href={DAO_PROPOSAL_URL(daoId, inv.daoProposalId)} external variant="secondary" size="sm">
                <Landmark className="h-3.5 w-3.5" /> DAO proposal #{inv.daoProposalId}
              </LinkButton>
            )}
            {inv.txHash && (
              <LinkButton href={EXPLORER_TX(inv.txHash)} external variant="secondary" size="sm">
                <ExternalLink className="h-3.5 w-3.5" /> Explorer
              </LinkButton>
            )}
            {canPay && (
              inv.status === "blocked" ? (
                // Override for the demo: shows the contract refusing what the rules already blocked.
                <Button size="sm" variant="secondary" onClick={() => setPayOpen(true)}>
                  <Zap className="h-3.5 w-3.5 text-danger" /> Force pay
                </Button>
              ) : (
                <Button size="sm" onClick={() => setPayOpen(true)}>
                  <Zap className="h-3.5 w-3.5" /> Pay now
                </Button>
              )
            )}
          </div>
        </div>
      </div>

      {/* Status banner */}
      <div
        className={cn(
          "flex flex-col gap-2 rounded-lg border px-4 py-3 text-[13px] sm:flex-row sm:items-center sm:justify-between",
          inv.status === "blocked" || inv.status === "failed"
            ? "border-danger/30 bg-danger-soft text-danger"
            : inv.status === "pending_approval"
              ? "border-violet/30 bg-violet-soft text-violet"
              : inv.status === "paid"
                ? "border-ok/30 bg-ok-soft text-ok"
                : inv.status === "needs_review"
                  ? "border-warn/30 bg-warn-soft text-warn"
                  : "border-border bg-surface text-muted",
        )}
      >
        <span>
          <b className="font-semibold">{meta.label}.</b> {meta.description}
        </span>
        {inv.status === "pending_approval" && (source === "mock" || company?.integrations?.chain === "simulated") && (
          <Button
            size="sm"
            variant="secondary"
            loading={approving}
            onClick={async () => {
              setApproving(true);
              try {
                await api.simulateDaoApproval(inv.id);
                await mutate();
                refreshAll();
              } finally {
                setApproving(false);
              }
            }}
          >
            Simulate DAO approval
          </Button>
        )}
      </div>

      {inv.status === "pending_approval" && inv.daoProposalId != null && daoId && source !== "mock" && company?.integrations?.chain !== "simulated" && (
        <DaoVote daoId={daoId} proposalId={inv.daoProposalId} onVoted={() => { void mutate(); refreshAll(); }} />
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-5">
          {/* Risk flags */}
          <Card className="overflow-hidden">
            <CardHeader
              title="Risk checks"
              description="Deterministic rules run after extraction. Invoice text is treated as data, never instructions."
              action={
                flags.length === 0 ? (
                  <Pill tone="ok" dot>
                    All clear
                  </Pill>
                ) : (
                  <span className="num text-xs text-muted">{flags.length} flag{flags.length > 1 ? "s" : ""}</span>
                )
              }
            />
            {flags.length ? (
              <ul className="divide-y divide-border">
                {flags.map((f) => (
                  <RiskFlagItem key={f.code} flag={f} />
                ))}
              </ul>
            ) : (
              <div className="flex items-center gap-2 px-4 py-4 text-[13px] text-muted">
                <ShieldCheck className="h-4 w-4 text-ok" />
                {inv.extracted ? "Payee allowlisted, PO matched, no duplicates, no injected instructions." : "Checks run once extraction completes."}
              </div>
            )}
          </Card>

          {/* Extracted fields */}
          <Card className="overflow-hidden">
            <CardHeader title="Extracted fields" description="Read from the PDF by NEAR AI Cloud, Zod-validated" />
            {inv.extracted ? (
              <>
                <dl className="divide-y divide-border">
                  <Row label="Invoice number" mono>
                    {ex.invoiceNumber}
                  </Row>
                  <Row label="Payee name">{ex.payeeName}</Row>
                  <Row label="Account on invoice" mono highlight={accountMismatch ? "danger" : undefined}>
                    {ex.payeeNearAccount}
                    {accountMismatch && payee && (
                      <span className="mt-0.5 block font-sans text-xs font-normal text-danger">
                        Allowlisted account is <span className="num">{payee.nearAccountId}</span>. The agent never pays the account written on an invoice.
                      </span>
                    )}
                  </Row>
                  <Row label="Amount" mono>
                    {ex.amount ? `${formatUsdc(ex.amount)} ${ex.currency ?? ""}` : null}
                  </Row>
                  <Row label="Due date">{ex.dueDate ? formatDate(ex.dueDate) : null}</Row>
                  <Row label="PO number" mono highlight={!ex.poNumber ? "warn" : undefined}>
                    {ex.poNumber ?? <span className="font-sans text-warn">None referenced</span>}
                  </Row>
                </dl>
                {(ex.lineItems?.length ?? 0) > 0 && (
                  <div className="overflow-x-auto border-t border-border">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="text-left text-[11.5px] uppercase tracking-wide text-faint">
                          <th className="px-4 py-2 font-medium">Line item</th>
                          <th className="px-3 py-2 text-right font-medium">Qty</th>
                          <th className="px-4 py-2 text-right font-medium">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {ex.lineItems!.map((li, i) => (
                          <tr key={i}>
                            <td className="px-4 py-2">{li.description}</td>
                            <td className="num px-3 py-2 text-right text-muted">{li.quantity ?? 1}</td>
                            <td className="px-4 py-2 text-right">
                              <Amount value={li.amount} unit={false} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-2 p-4">
                <p className="text-[13px] text-muted">The agent is still reading this invoice…</p>
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Timeline" description="From upload to settlement" />
            {activity.length ? <Timeline items={activity} /> : <p className="px-4 py-4 text-[13px] text-muted">No events yet.</p>}
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          {/* PO match */}
          <Card className="overflow-hidden">
            <CardHeader
              title="Purchase order match"
              action={po ? <Pill tone={poDelta && poDelta > BigInt(0) ? "warn" : "ok"}>{poDelta && poDelta > BigInt(0) ? "Over PO" : "Matched"}</Pill> : <Pill tone="warn">No PO</Pill>}
            />
            {po ? (
              <dl className="divide-y divide-border">
                <Row label="PO" mono>
                  {po.number}
                </Row>
                <Row label="Description">{po.description}</Row>
                <Row label="PO amount" mono>
                  {formatUsdc(po.amount)}
                </Row>
                <Row label="Invoice amount" mono>
                  {formatUsdc(inv.amount)}
                </Row>
                <Row label="Difference" mono highlight={poDelta && poDelta > BigInt(0) ? "warn" : undefined}>
                  <span className={cn(poDelta && poDelta > BigInt(0) ? "text-warn" : "text-ok")}>
                    {poDelta === null ? null : poDelta > BigInt(0) ? `+${formatUsdc(poDelta)}` : poDelta === BigInt(0) ? "Exact match" : formatUsdc(poDelta)}
                  </span>
                </Row>
                <Row label="PO status">{po.status}</Row>
              </dl>
            ) : (
              <p className="px-4 py-4 text-[13px] text-muted">
                {ex.poNumber ? (
                  <>
                    Invoice references <Mono>{ex.poNumber}</Mono>, which was not found.
                  </>
                ) : (
                  "This invoice doesn't reference a purchase order."
                )}
              </p>
            )}
          </Card>

          {/* Payee */}
          <Card className="overflow-hidden">
            <CardHeader title="Payee" action={payee ? <Pill tone={payee.status === "active" ? "ok" : "violet"}>{payee.status === "active" ? "Allowlisted" : "Change pending"}</Pill> : <Pill tone="danger">Not allowlisted</Pill>} />
            {payee ? (
              <dl className="divide-y divide-border">
                <Row label="Name">{payee.name}</Row>
                <Row label="Pays to" mono>
                  <a href={EXPLORER_ACCOUNT(payee.nearAccountId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-accent">
                    {payee.nearAccountId} <ExternalLink className="h-3 w-3" />
                  </a>
                </Row>
                <Row label="Email">{payee.email}</Row>
              </dl>
            ) : (
              <p className="px-4 py-4 text-[13px] text-muted">
                No allowlisted payee matched. The policy contract will refuse to pay{" "}
                {ex.payeeNearAccount ? <Mono className="text-danger">{ex.payeeNearAccount}</Mono> : "an unknown account"}.
              </p>
            )}
          </Card>

          {/* On-chain */}
          <Card className="overflow-hidden">
            <CardHeader title="On-chain" description="NEAR testnet" />
            <dl className="divide-y divide-border">
              <Row label="Transaction" mono>
                {inv.txHash ? (
                  <span className="inline-flex items-center gap-1">
                    <a href={EXPLORER_TX(inv.txHash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                      {shortHash(inv.txHash, 8)} <ExternalLink className="h-3 w-3" />
                    </a>
                    <CopyButton value={inv.txHash} />
                  </span>
                ) : null}
              </Row>
              <Row label="DAO proposal" mono>
                {inv.daoProposalId != null && daoId ? (
                  <a href={DAO_PROPOSAL_URL(daoId, inv.daoProposalId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                    #{inv.daoProposalId} <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </Row>
              <Row label="Policy contract" mono>
                {company?.policyContractId}
              </Row>
              <Row label="PDF sha256" mono>
                <span className="inline-flex items-center gap-1" title={inv.pdfHash}>
                  {shortHash(inv.pdfHash, 8)} <CopyButton value={inv.pdfHash} />
                </span>
              </Row>
              <Row label="Invoice id" mono>
                {inv.id}
              </Row>
            </dl>
          </Card>
        </div>
      </div>

      <PayNowDialog
        inv={inv}
        open={payOpen}
        onClose={() => setPayOpen(false)}
        onDone={() => {
          mutate();
          refreshAll();
        }}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/dashboard/invoices" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
      <ArrowLeft className="h-3.5 w-3.5" /> Invoices
    </Link>
  );
}
