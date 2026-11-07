"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { Inbox, Search, Upload } from "lucide-react";
import { Card, EmptyState, ErrorNote, Input, LinkButton, PageHeader } from "@/components/ui";
import { InvoiceTable, payeeName } from "@/components/invoice-table";
import { useInvoices, usePayees } from "@/lib/hooks";
import { cn, formatUsdc } from "@/lib/format";
import type { InvoiceStatus } from "@/lib/types";

const TABS: { key: string; label: string; statuses?: InvoiceStatus[] }[] = [
  { key: "all", label: "All" },
  { key: "blocked", label: "Blocked", statuses: ["blocked"] },
  { key: "needs_review", label: "Needs review", statuses: ["needs_review"] },
  { key: "pending_approval", label: "Awaiting DAO", statuses: ["pending_approval"] },
  { key: "processing", label: "Processing", statuses: ["received", "extracting"] },
  { key: "scheduled", label: "Scheduled", statuses: ["scheduled"] },
  { key: "paying", label: "Paying", statuses: ["paying"] },
  { key: "paid", label: "Paid", statuses: ["paid"] },
  { key: "failed", label: "Failed", statuses: ["failed"] },
  { key: "rejected", label: "Rejected", statuses: ["rejected"] },
];

function InvoicesView() {
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get("status") ?? "all";
  const tabKey = TABS.find((t) => t.key === raw || t.statuses?.includes(raw as InvoiceStatus))?.key ?? "all";
  const tab = TABS.find((t) => t.key === tabKey)!;
  const [q, setQ] = useState("");

  const { data: invoices, isLoading, error } = useInvoices();
  const { data: payees } = usePayees();

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of TABS) c[t.key] = t.statuses ? (invoices ?? []).filter((i) => t.statuses!.includes(i.status)).length : (invoices ?? []).length;
    return c;
  }, [invoices]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (invoices ?? [])
      .filter((i) => !tab.statuses || tab.statuses.includes(i.status))
      .filter(
        (i) =>
          !needle ||
          i.number.toLowerCase().includes(needle) ||
          payeeName(i, payees).toLowerCase().includes(needle) ||
          (i.extracted?.payeeNearAccount ?? "").toLowerCase().includes(needle),
      );
  }, [invoices, tab, q, payees]);

  const total = filtered.reduce((s, i) => s + BigInt(i.amount || "0"), BigInt(0));

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Every invoice the agent has received, with rule checks and on-chain outcome."
        actions={
          <LinkButton href="/portal" variant="primary" size="sm">
            <Upload className="h-3.5 w-3.5" /> Upload invoice
          </LinkButton>
        }
      />
      <div className="-mx-4 mb-3 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex w-max gap-1 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => router.replace(t.key === "all" ? "/dashboard/invoices" : `/dashboard/invoices?status=${t.key}`, { scroll: false })}
              className={cn(
                "-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-[13px] transition-colors",
                t.key === tabKey ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg",
              )}
            >
              {t.label}
              <span
                className={cn(
                  "num rounded px-1 text-[11px]",
                  t.key === tabKey ? "bg-accent-soft text-accent" : "bg-surface-2 text-faint",
                  (t.key === "blocked" || t.key === "failed") && counts[t.key] > 0 && t.key !== tabKey && "text-danger",
                )}
              >
                {invoices ? counts[t.key] : "·"}
              </span>
            </button>
          ))}
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-2 border-b border-border px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative sm:w-72">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-faint" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number, payee or account" className="h-9 pl-8" />
          </div>
          <div className="text-xs text-muted">
            <span className="num">{filtered.length}</span> invoices · <span className="num">{formatUsdc(total)}</span> USDC
          </div>
        </div>
        {error && (
          <div className="p-4">
            <ErrorNote error={error} />
          </div>
        )}
        {!isLoading && filtered.length === 0 ? (
          <EmptyState
            icon={<Inbox className="h-6 w-6" />}
            title={q ? "No matches" : `No ${tab.label.toLowerCase()} invoices`}
            description={q ? "Try a different search." : "Invoices appear here when contractors upload them through the portal."}
            action={
              !q && (
                <Link href="/portal" className="text-sm font-medium text-accent hover:underline">
                  Open contractor portal
                </Link>
              )
            }
          />
        ) : (
          <InvoiceTable invoices={filtered} payees={payees} loading={isLoading} />
        )}
      </Card>
    </>
  );
}

export default function InvoicesPage() {
  return (
    <Suspense>
      <InvoicesView />
    </Suspense>
  );
}
