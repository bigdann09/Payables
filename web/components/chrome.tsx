"use client";

import Link from "next/link";
import { useTheme } from "next-themes";
import { useState, useSyncExternalStore } from "react";
import { Database, LogOut, Moon, Sun, Wallet } from "lucide-react";
import { useDataSource } from "@/lib/hooks";
import { API_URL } from "@/lib/api";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/format";

export function Logo({ className, href = "/" }: { className?: string; href?: string }) {
  return (
    <Link href={href} className={cn("flex items-center gap-2 font-semibold tracking-tight", className)}>
      <span className="grid h-6 w-6 place-items-center rounded-[5px] bg-fg text-bg">
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="text-[15px]">Payables</span>
    </Link>
  );
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const dark = mounted && resolvedTheme === "dark";
  return (
    <button
      onClick={() => setTheme(dark ? "light" : "dark")}
      className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
      aria-label="Toggle theme"
      title="Toggle theme"
    >
      {mounted ? dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" /> : <span className="h-4 w-4" />}
    </button>
  );
}

export function ConnectWallet({ compact }: { compact?: boolean }) {
  const { ready, accountId, signIn, signOut } = useWallet();
  const [open, setOpen] = useState(false);
  if (accountId)
    return (
      <div className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2.5 text-[13px] font-medium hover:bg-surface-2"
          title={accountId}
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
          {compact ? <Wallet className="h-3.5 w-3.5" /> : <span className="num truncate">{accountId}</span>}
        </button>
        {open && (
          <div className="absolute right-0 top-10 z-50 w-56 rounded-md border border-border bg-surface p-1 text-[13px] shadow-lg">
            <div className="num truncate px-2.5 py-2 text-xs text-muted">{accountId}</div>
            <button
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left hover:bg-surface-2"
              onClick={async () => {
                setOpen(false);
                await signOut();
              }}
            >
              <LogOut className="h-3.5 w-3.5" /> Disconnect
            </button>
          </div>
        )}
      </div>
    );
  return (
    <button
      onClick={signIn}
      disabled={!ready}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2.5 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-60"
    >
      <Wallet className="h-3.5 w-3.5" />
      {!compact && "Connect wallet"}
    </button>
  );
}

export function DataSourceBadge() {
  const src = useDataSource();
  if (src !== "mock") return null;
  return (
    <span
      title={`Using built-in demo data (API at ${API_URL} unreachable or NEXT_PUBLIC_USE_MOCKS=true)`}
      className="inline-flex items-center gap-1 rounded-full border border-warn/30 bg-warn-soft px-2 py-0.5 text-[11px] font-medium text-warn"
    >
      <Database className="h-3 w-3" />
      Mock data
    </span>
  );
}
