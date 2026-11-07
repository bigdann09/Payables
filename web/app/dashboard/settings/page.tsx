"use client";

import { useEffect, useState } from "react";
import { Check, ExternalLink } from "lucide-react";
import { Button, Card, CardHeader, ErrorNote, Field, Input, PageHeader, Skeleton } from "@/components/ui";
import { api, API_URL } from "@/lib/api";
import { useCompany, useDataSource, useRefreshAll } from "@/lib/hooks";
import { EXPLORER_ACCOUNT, formatUsdc, parseUsdc, usdcToInput } from "@/lib/format";
import type { Company } from "@/lib/types";

function AccountRow({ label, id, note }: { label: string; id?: string | null; note?: string }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-[13px] font-medium">{label}</div>
        {note && <div className="text-xs text-muted">{note}</div>}
      </div>
      {id ? (
        <a href={EXPLORER_ACCOUNT(id)} target="_blank" rel="noreferrer" className="num inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline">
          {id} <ExternalLink className="h-3 w-3" />
        </a>
      ) : (
        <span className="text-xs text-faint">—</span>
      )}
    </div>
  );
}

function SettingsForm({ company }: { company: Company }) {
  const refresh = useRefreshAll();
  const [limit, setLimit] = useState(usdcToInput(company.autoPayLimit));
  const [cap, setCap] = useState(usdcToInput(company.dailyCap));
  const [chat, setChat] = useState(company.telegramChatId ?? "");
  const [email, setEmail] = useState(company.notifyEmail ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const limitBase = parseUsdc(limit);
  const capBase = parseUsdc(cap);
  const limitErr = !limitBase ? "Enter a USDC amount" : null;
  const capErr = !capBase ? "Enter a USDC amount" : limitBase && capBase && BigInt(capBase) < BigInt(limitBase) ? "Daily cap should be at least the auto-pay limit" : null;
  const emailErr = email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? "Enter a valid email" : null;
  const limitsChanged = limitBase !== company.autoPayLimit || capBase !== company.dailyCap;

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(t);
  }, [saved]);

  return (
    <form
      className="space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        if (limitErr || capErr || emailErr) return;
        setBusy(true);
        setErr(null);
        try {
          await api.patchCompany({
            autoPayLimit: limitBase!,
            dailyCap: capBase!,
            telegramChatId: chat.trim() || null,
            notifyEmail: email.trim() || null,
          });
          refresh();
          setSaved(true);
        } catch (e) {
          setErr(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Card>
        <CardHeader title="Payment policy" description="Enforced by the policy contract via set_limits. The agent cannot change these." />
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label="Auto-pay limit (USDC)" htmlFor="s-limit" error={limitErr} hint="Invoices at or below this amount are paid without approval.">
            <Input id="s-limit" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} className="num" />
          </Field>
          <Field label="Daily cap (USDC)" htmlFor="s-cap" error={capErr} hint="Total auto-paid per UTC day. Beyond it, everything escalates to the DAO.">
            <Input id="s-cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} className="num" />
          </Field>
        </div>
        {limitsChanged && !limitErr && !capErr && (
          <div className="mx-4 mb-4 rounded-md border border-info/25 bg-info-soft px-3 py-2 text-xs text-info">
            Saving sends <span className="num">set_limits({formatUsdc(limitBase)}, {formatUsdc(capBase)})</span> to {company.policyContractId}.
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Notifications" description="Approval needed, paid, blocked and failed events." />
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label="Telegram chat id" htmlFor="s-chat" hint="Add the Payables bot to your group, then paste the chat id.">
            <Input id="s-chat" value={chat} onChange={(e) => setChat(e.target.value)} placeholder="-1001234567890" className="num" />
          </Field>
          <Field label="Notification email" htmlFor="s-email" error={emailErr}>
            <Input id="s-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ap@company.com" />
          </Field>
        </div>
      </Card>

      <ErrorNote error={err} />
      <div className="flex items-center justify-end gap-3">
        {saved && (
          <span className="inline-flex items-center gap-1 text-sm text-ok">
            <Check className="h-4 w-4" /> Saved
          </span>
        )}
        <Button type="submit" loading={busy}>
          Save changes
        </Button>
      </div>
    </form>
  );
}

export default function SettingsPage() {
  const { data: company, error } = useCompany();
  const source = useDataSource();
  return (
    <>
      <PageHeader title="Settings" description={company ? company.name : "Company policy and notifications"} />
      <ErrorNote error={error} />
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0">{company ? <SettingsForm key={company.id} company={company} /> : <Skeleton className="h-96" />}</div>
        <div className="min-w-0 space-y-5">
          <Card className="overflow-hidden">
            <CardHeader title="On-chain accounts" description="NEAR testnet" />
            <div className="divide-y divide-border">
              <AccountRow label="Policy contract" id={company?.policyContractId} note="Holds the treasury, enforces limits" />
              <AccountRow label="DAO" id={company?.daoId} note="Approves over-limit payments & payee changes" />
              <AccountRow label="Agent" id={company?.onChain?.agent_id} note="Function-call key: request_payment only" />
              <AccountRow label="USDC token" id={company?.onChain?.usdc_id} />
              <AccountRow label="Owner" id={company?.onChain?.owner_id} />
            </div>
          </Card>
          <Card className="p-4 text-xs text-muted">
            <div className="mb-1 font-medium text-fg">Data source</div>
            {source === "mock" ? "Built-in demo data (API unreachable or mocks forced)." : source === "api" ? "Live API" : "Checking…"}
            <div className="num mt-1 break-all text-faint">{API_URL}</div>
          </Card>
        </div>
      </div>
    </>
  );
}
