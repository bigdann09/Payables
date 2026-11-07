"use client";

import Link from "next/link";
import { ArrowRight, Landmark, ShieldAlert, Upload } from "lucide-react";
import { Card, CardHeader, EmptyState, ErrorNote, LinkButton, PageHeader, Skeleton } from "@/components/ui";
import { InvoiceTable } from "@/components/invoice-table";
import { ActivityFeed } from "@/components/activity-feed";
import { useActivity, useCompany, useInvoices, usePayees, useStats } from "@/lib/hooks";
import { cn, formatUsdc, ratio } from "@/lib/format";
import type { InvoiceStatus } from "@/lib/types";

const ATTENTION: InvoiceStatus[] = ["blocked", "pending_approval", "needs_review", "failed"];

function Stat({
  label,
  value,
  sub,
  tone,
  href,
  loading,
  children,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "danger" | "violet";
  href?: string;
  loading?: boolean;
  children?: React.ReactNode;
}) {
  const inner = (
    <div className="flex h-full flex-col p-4">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      {loading ? (
        <Skeleton className="mt-2.5 h-7 w-28" />
      ) : (
        <div className={cn("num mt-1.5 text-[22px] font-semibold tracking-tight", tone === "danger" && "text-danger", tone === "violet" && "text-violet")}>{value}</div>
      )}
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
      {children}
    </div>
  );
  return (
    <Card className={cn("overflow-hidden", href && "transition-colors hover:border-border-strong")}>
      {href ? (
        <Link href={href} className="block h-full">
          {inner}
        </Link>
      ) : (
        inner
      )}
    </Card>
  );
}

export default function OverviewPage() {
  const { data: stats, error: statsError } = useStats();
  const { data: company } = useCompany();
  const { data: invoices, isLoading } = useInvoices();
  const { data: payees } = usePayees();
  const { data: activity } = useActivity();

  const attention = (invoices ?? [])
    .filter((i) => ATTENTION.includes(i.status))
    .sort((a, b) => ATTENTION.indexOf(a.status) - ATTENTION.indexOf(b.status));
  const used = stats ? ratio(stats.dailySpent, stats.dailyCap) : 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description={company ? `${company.name} · auto-pay up to ${formatUsdc(company.autoPayLimit, { decimals: 0 })} USDC, above that the DAO decides.` : "Treasury, payments and policy at a glance."}
        actions={
          <>
            <LinkButton href="/portal" variant="secondary" size="sm">
              <Upload className="h-3.5 w-3.5" /> Upload invoice
            </LinkButton>
            <LinkButton href="/dashboard/invoices" variant="primary" size="sm">
              All invoices <ArrowRight className="h-3.5 w-3.5" />
            </LinkButton>
          </>
        }
      />
      {statsError && (
        <div className="mb-4">
          <ErrorNote error={statsError} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <div className="col-span-2 lg:col-span-1">
          <Stat
            label="Treasury balance"
            loading={!stats}
            value={
              <>
                {formatUsdc(stats?.treasuryBalance)}
                <span className="ml-1 text-xs font-normal text-muted">USDC</span>
              </>
            }
            sub={company ? <span className="num">{company.policyContractId}</span> : undefined}
          />
        </div>
        <div className="col-span-2 lg:col-span-1">
          <Stat label="Paid this month" loading={!stats} value={formatUsdc(stats?.paidThisMonth)} sub="USDC settled on-chain" />
        </div>
        <Stat
          label="Pending approvals"
          loading={!stats}
          value={stats?.pendingApprovals ?? 0}
          tone={stats?.pendingApprovals ? "violet" : undefined}
          sub="Open DAO proposals"
          href="/dashboard/invoices?status=pending_approval"
        />
        <Stat
          label="Blocked"
          loading={!stats}
          value={stats?.blockedCount ?? 0}
          tone={stats?.blockedCount ? "danger" : undefined}
          sub="Stopped by risk rules"
          href="/dashboard/invoices?status=blocked"
        />
        <div className="col-span-2 lg:col-span-1">
          <Stat
            label="Daily spend vs cap"
            loading={!stats}
            value={
              <>
                {formatUsdc(stats?.dailySpent, { decimals: 0 })}
                <span className="text-sm font-normal text-muted"> / {formatUsdc(stats?.dailyCap, { decimals: 0 })}</span>
              </>
            }
          >
            <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className={cn("h-full rounded-full transition-all", used > 0.9 ? "bg-danger" : used > 0.7 ? "bg-warn" : "bg-accent")}
                style={{ width: `${Math.min(100, used * 100)}%` }}
              />
            </div>
            <div className="mt-1.5 text-xs text-muted">{Math.round(used * 100)}% of today&apos;s UTC cap used</div>
          </Stat>
        </div>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_380px]">
        <Card className="min-w-0 overflow-hidden">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-warn" /> Needs attention
                {attention.length > 0 && <span className="num rounded-full bg-surface-2 px-1.5 text-[11px] text-muted">{attention.length}</span>}
              </span>
            }
            description="Blocked, awaiting DAO approval, flagged for review, or failed."
            action={
              <Link href="/dashboard/invoices" className="text-xs font-medium text-accent hover:underline">
                View all
              </Link>
            }
          />
          {!isLoading && attention.length === 0 ? (
            <EmptyState icon={<Landmark className="h-6 w-6" />} title="Nothing needs you" description="Every invoice is scheduled, paying or paid." />
          ) : (
            <InvoiceTable invoices={attention} payees={payees} loading={isLoading} compact />
          )}
        </Card>

        <Card className="min-w-0 overflow-hidden">
          <CardHeader title="Recent activity" description="Agent, contract and DAO events" />
          {activity ? (
            <div className="max-h-[560px] overflow-y-auto">
              <ActivityFeed items={activity} limit={25} />
            </div>
          ) : (
            <div className="space-y-3 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
