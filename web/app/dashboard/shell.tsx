"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useState } from "react";
import { ExternalLink, FileText, LayoutGrid, Menu, Receipt, Settings, ShieldCheck, Upload, Users, X } from "lucide-react";
import { ConnectWallet, DataSourceBadge, Logo, ThemeToggle } from "@/components/chrome";
import { useCompany, useStats } from "@/lib/hooks";
import { cn, EXPLORER_ACCOUNT } from "@/lib/format";

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutGrid, exact: true },
  { href: "/dashboard/invoices", label: "Invoices", icon: Receipt },
  { href: "/dashboard/payees", label: "Payees", icon: Users },
  { href: "/dashboard/purchase-orders", label: "Purchase orders", icon: FileText },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const { data: stats } = useStats();
  const attention = stats ? stats.blockedCount + stats.pendingApprovals : 0;
  return (
    <nav className="space-y-0.5">
      {NAV.map(({ href, label, icon: Icon, exact }) => {
        const active = exact ? path === href : path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={cn(
              "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] transition-colors",
              active ? "bg-surface-2 font-medium text-fg" : "text-muted hover:bg-surface-2/70 hover:text-fg",
            )}
          >
            <Icon className={cn("h-4 w-4", active ? "text-accent" : "text-faint group-hover:text-muted")} />
            <span className="flex-1">{label}</span>
            {href === "/dashboard/invoices" && attention > 0 && (
              <span className="num rounded-full bg-danger-soft px-1.5 text-[11px] font-medium text-danger">{attention}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function PolicyCard() {
  const { data: company } = useCompany();
  return (
    <div className="rounded-lg border border-border bg-surface p-3 text-xs">
      <div className="mb-2 flex items-center gap-1.5 font-medium text-fg">
        <ShieldCheck className="h-3.5 w-3.5 text-accent" /> Policy contract
      </div>
      {company ? (
        <a href={EXPLORER_ACCOUNT(company.policyContractId)} target="_blank" rel="noreferrer" className="num flex items-center gap-1 break-all text-muted hover:text-fg">
          {company.policyContractId}
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      ) : (
        <div className="skeleton h-3 w-32" />
      )}
      <p className="mt-2 leading-relaxed text-faint">The agent can only call request_payment. Limits are enforced on-chain.</p>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { data: company } = useCompany();
  return (
    <div className="flex h-full flex-col gap-5 p-3">
      <div className="flex items-center justify-between px-1.5 pt-1">
        <Logo href="/dashboard" />
      </div>
      <div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-2.5 py-2">
        <div className="grid h-7 w-7 place-items-center rounded-md bg-accent text-[12px] font-bold text-accent-fg">
          {(company?.name ?? "A").slice(0, 1)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">{company?.name ?? "Loading…"}</div>
          <div className="text-[11px] text-muted">NEAR testnet</div>
        </div>
      </div>
      <Suspense fallback={<div className="h-44" />}>
        <Nav onNavigate={onNavigate} />
      </Suspense>
      <div className="mt-auto space-y-3">
        <Link
          href="/portal"
          className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg"
          onClick={onNavigate}
        >
          <Upload className="h-4 w-4 text-faint" /> Contractor portal
        </Link>
        <PolicyCard />
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-border bg-bg lg:block">
        <Sidebar />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-border bg-bg shadow-xl">
            <button className="absolute right-2 top-3 rounded p-1.5 text-muted hover:bg-surface-2" onClick={() => setOpen(false)} aria-label="Close menu">
              <X className="h-4 w-4" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-bg/85 px-4 backdrop-blur sm:px-6">
          <button className="-ml-1.5 rounded p-1.5 text-muted hover:bg-surface-2 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu className="h-4 w-4" />
          </button>
          <div className="lg:hidden">
            <Logo href="/dashboard" />
          </div>
          <div className="flex-1" />
          <DataSourceBadge />
          <ThemeToggle />
          <div className="hidden sm:block">
            <ConnectWallet />
          </div>
          <div className="sm:hidden">
            <ConnectWallet compact />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
