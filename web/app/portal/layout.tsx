import type { Metadata } from "next";
import Link from "next/link";
import { DataSourceBadge, Logo, ThemeToggle } from "@/components/chrome";

export const metadata: Metadata = { title: "Contractor portal" };

export default function PortalLayout({ children }: LayoutProps<"/portal">) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex h-12 max-w-3xl items-center gap-3 px-4">
          <Logo href="/portal" />
          <span className="hidden text-[13px] text-muted sm:inline">Contractor portal</span>
          <div className="flex-1" />
          <DataSourceBadge />
          <ThemeToggle />
          <Link href="/dashboard" className="text-[13px] text-muted hover:text-fg">
            Company login
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:py-12">{children}</main>
      <footer className="mx-auto w-full max-w-3xl px-4 pb-8 text-xs text-faint">Payments settle in USDC on NEAR testnet to your registered account.</footer>
    </div>
  );
}
