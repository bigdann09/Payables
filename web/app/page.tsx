import Link from "next/link";
import { ArrowRight, Bot, FileText, Landmark, ShieldCheck, Swords } from "lucide-react";
import { Logo, ThemeToggle } from "@/components/chrome";
import { buttonClass } from "@/components/button-class";

const OUTCOMES = [
  { who: "Northwind Design", amt: "3.50", tag: "Paid", note: "≤ 5 USDC limit · PO-1041 matched", cls: "text-ok bg-ok-soft border-ok/25" },
  { who: "Kestrel Labs", amt: "8.00", tag: "DAO vote", note: "> 5 USDC limit · proposal #37", cls: "text-violet bg-violet-soft border-violet/25" },
  { who: "“Consulting Services”", amt: "50,000.00", tag: "Blocked", note: "Prompt injection · evil.testnet", cls: "text-danger bg-danger-soft border-danger/25" },
];

export default function Landing() {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden">
      <div className="grid-bg pointer-events-none absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_at_70%_40%,black,transparent_70%)]" />
      <header className="relative z-10 mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Logo />
        <div className="flex-1" />
        <Link href="/try" className="hidden text-[13px] text-muted hover:text-fg sm:block">
          Try to break it
        </Link>
        <Link href="/portal" className="hidden text-[13px] text-muted hover:text-fg sm:block">
          Contractor portal
        </Link>
        <ThemeToggle />
        <Link href="/dashboard" className={buttonClass("secondary", "sm")}>
          Dashboard
        </Link>
      </header>

      <main className="relative z-10 mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
        <div>
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" /> AI accounts payable · USDC on NEAR
          </div>
          <h1 className="text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-[56px]">
            The agent pays.
            <br />
            <span className="text-accent">The contract decides.</span>
          </h1>
          <p className="mt-5 max-w-lg text-[16px] leading-relaxed text-muted">
            Payables reads supplier invoices, matches them to purchase orders and pays them in USDC. Every payment goes through an on-chain policy: allowlisted payees, auto-pay limits, daily caps, and a DAO vote for anything bigger. A compromised or prompt-injected agent can&apos;t move a cent outside it.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/dashboard" className={buttonClass("primary", "md", "h-10 px-4")}>
              Open company dashboard <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/try" className={buttonClass("secondary", "md", "h-10 px-4")}>
              <Swords className="h-4 w-4 text-danger" /> Attack the live contract
            </Link>
          </div>
          <dl className="mt-10 grid max-w-lg grid-cols-3 gap-4 border-t border-border pt-5 text-[13px]">
            {[
              { icon: Bot, t: "Agent", d: "Extracts & checks. One key: request_payment." },
              { icon: ShieldCheck, t: "Policy", d: "Allowlist, limits, caps, dedupe — on-chain." },
              { icon: Landmark, t: "DAO", d: "Approves over-limit pays & account changes." },
            ].map(({ icon: Icon, t, d }) => (
              <div key={t}>
                <dt className="flex items-center gap-1.5 font-medium">
                  <Icon className="h-3.5 w-3.5 text-accent" /> {t}
                </dt>
                <dd className="mt-1 text-xs leading-relaxed text-muted">{d}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="relative">
          <div className="rounded-xl border border-border bg-surface shadow-[0_24px_60px_-30px_rgba(0,0,0,0.35)]">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2 text-[13px] font-medium">
                <FileText className="h-4 w-4 text-muted" /> Today&apos;s invoices
              </div>
              <span className="num text-[11px] text-faint">acme.payables.testnet</span>
            </div>
            <ul className="divide-y divide-border">
              {OUTCOMES.map((o) => (
                <li key={o.who} className="flex items-center gap-3 px-4 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium">{o.who}</div>
                    <div className="mt-0.5 truncate text-xs text-muted">{o.note}</div>
                  </div>
                  <div className="num text-[13px]">{o.amt}</div>
                  <span className={`w-[74px] rounded-full border px-2 py-0.5 text-center text-[11.5px] font-medium ${o.cls}`}>{o.tag}</span>
                </li>
              ))}
            </ul>
            <div className="border-t border-border bg-surface-2/60 px-4 py-3">
              <div className="num rounded-md border border-border bg-bg px-3 py-2 text-[11.5px] leading-relaxed text-muted">
                <span className="text-faint">{"// policy contract"}</span>
                <br />
                <span className="text-accent">assert</span>!(payees.contains(payee));
                <br />
                <span className="text-accent">if</span> amount &lt;= auto_pay_limit &amp;&amp; under_daily_cap {"{"} ft_transfer {"}"}
                <br />
                <span className="text-accent">else</span> {"{"} dao.add_proposal(release_payment) {"}"}
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="relative z-10 mx-auto w-full max-w-6xl px-4 pb-6 text-xs text-faint sm:px-6">Built on NEAR testnet · Sputnik DAO v2 · NEAR AI Cloud</footer>
    </div>
  );
}
