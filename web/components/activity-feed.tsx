"use client";

import { useRouter } from "next/navigation";
import {
  AlertOctagon,
  Ban,
  Bell,
  CheckCircle2,
  CircleDot,
  Clock,
  ExternalLink,
  FileInput,
  FilePlus2,
  Landmark,
  ScanText,
  Send,
  Settings2,
  UserPlus,
  Users,
  XCircle,
  Zap,
} from "lucide-react";
import { cn, EXPLORER_TX, formatDateTime, shortHash, timeAgo } from "@/lib/format";
import type { ActivityLog } from "@/lib/types";

const TYPE_META: Record<string, { icon: typeof CircleDot; tone: string }> = {
  invoice_received: { icon: FileInput, tone: "text-muted" },
  extraction_started: { icon: ScanText, tone: "text-info" },
  extraction_completed: { icon: ScanText, tone: "text-info" },
  risk_flagged: { icon: AlertOctagon, tone: "text-danger" },
  payment_scheduled: { icon: Clock, tone: "text-accent" },
  payment_requested: { icon: Send, tone: "text-info" },
  payment_escalated: { icon: Landmark, tone: "text-violet" },
  dao_approved: { icon: Landmark, tone: "text-ok" },
  payment_paid: { icon: CheckCircle2, tone: "text-ok" },
  payment_failed: { icon: XCircle, tone: "text-danger" },
  payment_rejected: { icon: Ban, tone: "text-muted" },
  payee_registered: { icon: UserPlus, tone: "text-accent" },
  payee_change_requested: { icon: Users, tone: "text-violet" },
  notification_sent: { icon: Bell, tone: "text-faint" },
  settings_updated: { icon: Settings2, tone: "text-muted" },
  po_created: { icon: FilePlus2, tone: "text-muted" },
  pay_now: { icon: Zap, tone: "text-warn" },
};

export function activityMeta(type: string) {
  return TYPE_META[type] ?? { icon: CircleDot, tone: "text-faint" };
}

function txOf(a: ActivityLog): string | null {
  const t = a.data && typeof a.data === "object" ? (a.data as Record<string, unknown>).txHash : null;
  return typeof t === "string" ? t : null;
}

export function ActivityFeed({ items, linkInvoices = true, limit }: { items: ActivityLog[]; linkInvoices?: boolean; limit?: number }) {
  const router = useRouter();
  const list = limit ? items.slice(0, limit) : items;
  return (
    <ol className="divide-y divide-border">
      {list.map((a) => {
        const { icon: Icon, tone } = activityMeta(a.type);
        const tx = txOf(a);
        const body = (
          <div className="flex gap-3 px-4 py-2.5">
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone)} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-snug">{a.message}</p>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-faint">
                <span title={formatDateTime(a.createdAt)}>{timeAgo(a.createdAt)}</span>
                <span className="num">{a.type}</span>
                {tx && (
                  <a
                    href={EXPLORER_TX(tx)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="num inline-flex items-center gap-0.5 text-muted hover:text-accent"
                  >
                    tx {shortHash(tx, 4)} <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
              </div>
            </div>
          </div>
        );
        return (
          <li key={a.id}>
            {linkInvoices && a.invoiceId ? (
              <div
                role="link"
                tabIndex={0}
                onClick={() => router.push(`/dashboard/invoices/${a.invoiceId}`)}
                onKeyDown={(e) => e.key === "Enter" && router.push(`/dashboard/invoices/${a.invoiceId}`)}
                className="block cursor-pointer hover:bg-surface-2/60"
              >
                {body}
              </div>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Vertical timeline for invoice detail (oldest first). */
export function Timeline({ items }: { items: ActivityLog[] }) {
  const list = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <ol className="relative px-4 py-3">
      {list.map((a, i) => {
        const { icon: Icon, tone } = activityMeta(a.type);
        const tx = txOf(a);
        return (
          <li key={a.id} className="relative flex gap-3 pb-4 last:pb-0">
            {i < list.length - 1 && <span className="absolute left-[11px] top-6 bottom-0 w-px bg-border" />}
            <span className="z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-border bg-surface">
              <Icon className={cn("h-3.5 w-3.5", tone)} />
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="text-[13px] leading-snug">{a.message}</p>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px] text-faint">
                <span>{formatDateTime(a.createdAt)}</span>
                {tx && (
                  <a href={EXPLORER_TX(tx)} target="_blank" rel="noreferrer" className="num inline-flex items-center gap-0.5 text-muted hover:text-accent">
                    {shortHash(tx, 5)} <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
