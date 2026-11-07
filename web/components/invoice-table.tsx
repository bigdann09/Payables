"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { Amount, RiskChips, StatusBadge } from "./status";
import { Skeleton } from "./ui";
import { formatDate, timeAgo } from "@/lib/format";
import type { Invoice, Payee } from "@/lib/types";

export function payeeName(inv: Invoice, payees?: Payee[]) {
  return inv.payee?.name ?? payees?.find((p) => p.id === inv.payeeId)?.name ?? inv.extracted?.payeeName ?? "Unmatched payee";
}

export function InvoiceTable({ invoices, payees, loading, compact }: { invoices?: Invoice[]; payees?: Payee[]; loading?: boolean; compact?: boolean }) {
  const router = useRouter();
  if (loading && !invoices)
    return (
      <div className="space-y-3 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-6" />
        ))}
      </div>
    );
  const list = invoices ?? [];
  return (
    <>
      {/* Mobile list */}
      <ul className="divide-y divide-border md:hidden">
        {list.map((inv) => (
          <li key={inv.id}>
            <Link href={`/dashboard/invoices/${inv.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2/60">
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13.5px] font-medium">{payeeName(inv, payees)}</span>
                  <Amount value={inv.amount} className="text-[13px]" unit={false} />
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="num truncate text-xs text-muted">{inv.number}</span>
                  <StatusBadge status={inv.status} />
                </div>
                {(inv.riskFlags?.length ?? 0) > 0 && (
                  <div className="mt-1.5">
                    <RiskChips flags={inv.riskFlags} max={3} />
                  </div>
                )}
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-faint" />
            </Link>
          </li>
        ))}
      </ul>
      {/* Desktop table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-[11.5px] uppercase tracking-wide text-faint">
              <th className="px-4 py-2 font-medium">Payee</th>
              <th className="px-3 py-2 font-medium">Invoice</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Risk</th>
              {!compact && <th className="px-3 py-2 font-medium">Due</th>}
              <th className="px-4 py-2 text-right font-medium">Received</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {list.map((inv) => (
              <tr
                key={inv.id}
                onClick={() => router.push(`/dashboard/invoices/${inv.id}`)}
                className="cursor-pointer transition-colors hover:bg-surface-2/60"
              >
                <td className="max-w-[220px] px-4 py-2.5">
                  <Link href={`/dashboard/invoices/${inv.id}`} className="block truncate font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                    {payeeName(inv, payees)}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-3 py-2.5">
                  <span className="num text-[12.5px] text-muted">{inv.number}</span>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Amount value={inv.amount} unit={false} />
                </td>
                <td className="px-3 py-2.5">
                  <StatusBadge status={inv.status} />
                </td>
                <td className="px-3 py-2.5">
                  <RiskChips flags={inv.riskFlags} />
                </td>
                {!compact && <td className="whitespace-nowrap px-3 py-2.5 text-muted">{formatDate(inv.dueDate)}</td>}
                <td className="whitespace-nowrap px-4 py-2.5 text-right text-muted">{timeAgo(inv.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
