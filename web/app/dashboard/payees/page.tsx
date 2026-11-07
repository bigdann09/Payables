"use client";

import { useState } from "react";
import { ArrowRight, ExternalLink, Landmark, Plus, Repeat, ShieldAlert, Users } from "lucide-react";
import { DaoVote } from "@/components/dao-vote";
import { Button, Card, CardHeader, Dialog, EmptyState, ErrorNote, Field, Input, PageHeader, Skeleton } from "@/components/ui";
import { PayeeStatusBadge, Pill, RISK_LABEL } from "@/components/status";
import { api } from "@/lib/api";
import { useCompany, useDataSource, useFlagged, useInvoices, usePayees, useRefreshAll } from "@/lib/hooks";
import { EXPLORER_ACCOUNT, formatDate, formatUsdc, isValidNearAccount, timeAgo } from "@/lib/format";
import type { FlaggedAddress, Payee } from "@/lib/types";

/** Warns when an account was targeted by a blocked invoice or attack; the API refuses it unless acknowledged. */
function FlagWarning({ hit, ack, setAck }: { hit: FlaggedAddress; ack: boolean; setAck: (v: boolean) => void }) {
  return (
    <div className="space-y-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <b>Flagged address.</b> <span className="num">{hit.account}</span> was the target of a blocked {hit.source === "attack" ? "attack" : "invoice"} (
          {RISK_LABEL[hit.reason] ?? hit.reason.replace(/_/g, " ").toLowerCase()}
          {hit.amount ? `, ${formatUsdc(hit.amount)} USDC` : ""}, {hit.hits}× since {formatDate(hit.firstSeen)}).
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="accent-[var(--color-danger)]" />
        I verified this account with the supplier by phone or another channel.
      </label>
    </div>
  );
}

function useFlagHit(account: string) {
  const { data: flagged } = useFlagged();
  const a = account.trim().toLowerCase();
  return a ? flagged?.find((f) => f.account === a) : undefined;
}

function AddPayeeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const refresh = useRefreshAll();
  const { data: company } = useCompany();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [account, setAccount] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [ack, setAck] = useState(false);
  const hit = useFlagHit(account);

  const accountErr = account && !isValidNearAccount(account.trim()) ? "Not a valid NEAR account id" : null;
  const emailErr = email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? "Enter a valid email" : null;
  const valid = name.trim() && email && account && !accountErr && !emailErr && (!hit || ack);

  const reset = () => {
    setName("");
    setEmail("");
    setAccount("");
    setTouched(false);
    setErr(null);
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Add payee"
      description="Registers the account on the policy contract allowlist and pays its USDC storage deposit."
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            form="add-payee"
            type="submit"
            loading={busy}
            disabled={(touched && !valid) || (!!hit && !ack)}
          >
            Register payee
          </Button>
        </>
      }
    >
      <form
        id="add-payee"
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setTouched(true);
          if (!valid) return;
          setBusy(true);
          setErr(null);
          try {
            await api.createPayee({ name: name.trim(), email: email.trim(), nearAccountId: account.trim(), ...(hit && ack ? { acknowledgeFlag: true } : {}) });
            refresh();
            reset();
            onClose();
          } catch (e) {
            setErr(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Legal name" htmlFor="p-name" error={touched && !name.trim() ? "Required" : null}>
          <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Northwind Design Studio" autoFocus />
        </Field>
        <Field label="Billing email" htmlFor="p-email" error={(touched && !email ? "Required" : null) ?? emailErr}>
          <Input id="p-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="billing@northwind.design" />
        </Field>
        <Field
          label="NEAR account"
          htmlFor="p-acct"
          error={(touched && !account ? "Required" : null) ?? accountErr}
          hint="Payments can only ever go to this account. Changing it later requires a DAO vote."
        >
          <Input
            id="p-acct"
            value={account}
            onChange={(e) => setAccount(e.target.value.toLowerCase())}
            placeholder="northwind.testnet"
            className="num"
            autoCapitalize="off"
            spellCheck={false}
          />
        </Field>
        {hit && <FlagWarning hit={hit} ack={ack} setAck={setAck} />}
        <div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
          Calls <span className="num">register_payee</span> on <span className="num">{company?.policyContractId ?? "the policy contract"}</span> using the owner key.
        </div>
        <ErrorNote error={err} />
      </form>
    </Dialog>
  );
}

function ChangeAccountDialog({ payee, onClose }: { payee: Payee | null; onClose: () => void }) {
  const refresh = useRefreshAll();
  const { data: company } = useCompany();
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [ack, setAck] = useState(false);
  const hit = useFlagHit(account);
  const accountErr =
    account && !isValidNearAccount(account.trim())
      ? "Not a valid NEAR account id"
      : payee && account.trim() === payee.nearAccountId
        ? "Same as current account"
        : null;

  return (
    <Dialog
      open={!!payee}
      onClose={() => {
        setAccount("");
        setErr(null);
        onClose();
      }}
      title="Change payout account"
      description={payee ? `For ${payee.name}` : undefined}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={busy}
            disabled={!account || !!accountErr || (!!hit && !ack)}
            onClick={async () => {
              if (!payee) return;
              setBusy(true);
              setErr(null);
              try {
                await api.patchPayee(payee.id, { nearAccountId: account.trim(), ...(hit && ack ? { acknowledgeFlag: true } : {}) });
                refresh();
                setAccount("");
                onClose();
              } catch (e) {
                setErr(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Landmark className="h-3.5 w-3.5" /> Open DAO proposal
          </Button>
        </>
      }
    >
      {payee && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-[13px]">
            <span className="num truncate">{payee.nearAccountId}</span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-faint" />
            <span className="num truncate text-accent">{account || "new-account.testnet"}</span>
          </div>
          <Field label="New NEAR account" htmlFor="c-acct" error={accountErr}>
            <Input
              id="c-acct"
              value={account}
              onChange={(e) => setAccount(e.target.value.toLowerCase())}
              placeholder="northwind-treasury.testnet"
              className="num"
              autoFocus
              spellCheck={false}
            />
          </Field>
          {hit && <FlagWarning hit={hit} ack={ack} setAck={setAck} />}
          <div className="rounded-md border border-violet/30 bg-violet-soft px-3 py-2.5 text-[13px] text-violet">
            <b>This will not take effect immediately.</b> Account changes are the #1 invoice-fraud vector, so the contract only accepts them from the DAO. Submitting calls{" "}
            <span className="num">request_payee_change</span>, which opens a proposal on <span className="num">{company?.daoId ?? "the DAO"}</span>. Payments keep going to the current account until the council approves.
          </div>
          <ErrorNote error={err} />
        </div>
      )}
    </Dialog>
  );
}

function FlaggedCard() {
  const { data: flagged } = useFlagged();
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Flagged addresses"
        description="Every account a blocked invoice or attack tried to get paid. Allowlisting one needs an explicit override."
        action={<span className="num text-xs text-muted">{flagged?.length ?? 0}</span>}
      />
      {!flagged?.length ? (
        <div className="px-4 pb-4 text-[13px] text-muted">None yet.</div>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {flagged.map((f) => (
            <li key={f.id} className="flex flex-col gap-1 px-4 py-2.5 text-[13px] sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-2">
                <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-danger" />
                <a href={EXPLORER_ACCOUNT(f.account)} target="_blank" rel="noreferrer" className="num truncate hover:text-accent">
                  {f.account}
                </a>
                <Pill tone={f.reason === "PROMPT_INJECTION" ? "danger" : f.reason === "DIRECT_ATTACK" ? "violet" : "warn"}>
                  {RISK_LABEL[f.reason] ?? (f.reason === "DIRECT_ATTACK" ? "Rogue agent" : f.reason)}
                </Pill>
              </div>
              <div className="num shrink-0 text-xs text-muted">
                {f.amount ? `${formatUsdc(f.amount)} USDC · ` : ""}
                {f.hits}× · {f.source} · {timeAgo(f.lastSeen)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function PayeesPage() {
  const { data: payees, isLoading, error } = usePayees();
  const { data: company } = useCompany();
  const source = useDataSource();
  const refresh = useRefreshAll();
  const realDao = source !== "mock" && company?.integrations?.chain !== "simulated" && !!company?.daoId;
  const { data: invoices } = useInvoices();
  const [addOpen, setAddOpen] = useState(false);
  const [changing, setChanging] = useState<Payee | null>(null);

  const paidTo = (id: string) =>
    (invoices ?? []).filter((i) => i.payeeId === id && i.status === "paid").reduce((s, i) => s + BigInt(i.amount), BigInt(0));

  return (
    <>
      <PageHeader
        title="Payees"
        description="The allowlist. The agent can only pay these accounts — the contract enforces it."
        actions={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Add payee
          </Button>
        }
      />
      <ErrorNote error={error} />
      <Card className="overflow-hidden">
        {isLoading && !payees ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !payees?.length ? (
          <EmptyState
            icon={<Users className="h-6 w-6" />}
            title="No payees yet"
            description="Add a supplier to allow the agent to pay them."
            action={
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="h-3.5 w-3.5" /> Add payee
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {payees.map((p) => (
              <li key={p.id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:flex-wrap sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-surface-2 text-[13px] font-semibold text-muted">
                    {p.name
                      .split(" ")
                      .slice(0, 2)
                      .map((w) => w[0])
                      .join("")}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[14px] font-medium">{p.name}</span>
                      <PayeeStatusBadge status={p.status} />
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted">
                      <a href={EXPLORER_ACCOUNT(p.nearAccountId)} target="_blank" rel="noreferrer" className="num inline-flex items-center gap-1 hover:text-accent">
                        {p.nearAccountId} <ExternalLink className="h-3 w-3" />
                      </a>
                      <span>{p.email}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-5 sm:justify-end">
                  <div className="text-right">
                    <div className="num text-[13px]">{formatUsdc(paidTo(p.id))}</div>
                    <div className="text-[11px] text-faint">paid · since {formatDate(p.createdAt)}</div>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => setChanging(p)} disabled={p.status === "pending_change"} title={p.status === "pending_change" ? "A change is already awaiting DAO approval" : undefined}>
                    <Repeat className="h-3.5 w-3.5" /> Change account
                  </Button>
                </div>
                {p.status === "pending_change" && p.pendingChangeProposalId != null && realDao && (
                  <div className="w-full sm:pl-12">
                    {p.pendingNearAccountId && (
                      <div className="mb-2 flex items-center gap-2 text-xs text-muted">
                        <span className="num">{p.nearAccountId}</span>
                        <ArrowRight className="h-3 w-3" />
                        <span className="num text-violet">{p.pendingNearAccountId}</span>
                      </div>
                    )}
                    <DaoVote daoId={company!.daoId} proposalId={p.pendingChangeProposalId} onVoted={refresh} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <div className="mt-5">
        <FlaggedCard />
      </div>
      <AddPayeeDialog open={addOpen} onClose={() => setAddOpen(false)} />
      <ChangeAccountDialog payee={changing} onClose={() => setChanging(null)} />
    </>
  );
}
