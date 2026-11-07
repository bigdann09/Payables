"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import useSWR from "swr";
import {
  Ban,
  Bot,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileText,
  FileWarning,
  Info,
  Landmark,
  MinusCircle,
  ScanText,
  ShieldAlert,
  ShieldCheck,
  Skull,
  Swords,
  Upload,
  XCircle,
} from "lucide-react";
import { Logo, ThemeToggle } from "@/components/chrome";
import { buttonClass } from "@/components/button-class";
import { Pill } from "@/components/status";
import { Button, ErrorNote, Input, Mono, Spinner } from "@/components/ui";
import { attackApi } from "@/lib/api";
import { cn, EXPLORER_ACCOUNT, formatUsdc, shortHash, timeAgo } from "@/lib/format";
import type { AttackRun, AttackStep, AttackStepStatus } from "@/lib/types";

const PRESET_ICON: Record<string, typeof Swords> = { "tampered-payee": FileWarning, "prompt-injection": Skull, duplicate: Copy };
const STEP_ICON: Record<AttackStep["key"], typeof Swords> = {
  received: FileText,
  extract: ScanText,
  rules: ShieldCheck,
  agent: Bot,
  contract: Landmark,
  flagged: ShieldAlert,
};
const STATUS_STYLE: Record<AttackStepStatus, { ring: string; icon: typeof Swords; label: string }> = {
  pass: { ring: "border-border-strong bg-surface text-muted", icon: CheckCircle2, label: "ok" },
  block: { ring: "border-danger/40 bg-danger-soft text-danger", icon: XCircle, label: "blocked" },
  skip: { ring: "border-warn/40 bg-warn-soft text-warn", icon: MinusCircle, label: "not sent" },
  info: { ring: "border-violet/40 bg-violet-soft text-violet", icon: Info, label: "" },
  error: { ring: "border-warn/40 bg-warn-soft text-warn", icon: XCircle, label: "error" },
};

export function AttackLab() {
  const info = useSWR("attack-info", attackApi.info, { refreshInterval: 15_000 });
  const [run, setRun] = useState<AttackRun | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [account, setAccount] = useState("my-wallet.testnet");
  const [amount, setAmount] = useState("25000");
  const fileRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  async function go(key: string, fn: () => Promise<AttackRun>) {
    setBusy(key);
    setErr(null);
    setRun(null);
    requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    try {
      setRun(await fn());
      void info.mutate();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  }

  const i = info.data;
  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="grid-bg pointer-events-none absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_at_30%_0%,black,transparent_65%)]" />
      <header className="relative z-10 mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Logo />
        <span className="rounded-full border border-danger/30 bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger">Judge mode</span>
        <div className="flex-1" />
        <ThemeToggle />
        <Link href="/dashboard" className={buttonClass("secondary", "sm")}>
          Dashboard
        </Link>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-6xl px-4 pb-16 pt-6 sm:px-6">
        {/* Hero */}
        <section className="grid gap-8 lg:grid-cols-[1.2fr_1fr] lg:items-end">
          <div>
            <h1 className="text-[34px] font-semibold leading-[1.08] tracking-[-0.03em] sm:text-[46px]">
              Try to make the agent <span className="text-danger">pay you.</span>
            </h1>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
              Each attack runs for real: the invoice goes through NEAR AI and the rule checks, then we assume the agent is compromised and let it sign the payment with its real key. The policy contract on NEAR testnet gets the last word. You don&apos;t need a wallet.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border text-[13px]">
            <Stat label="Attacks refused on-chain" value={i ? String(i.stats.refusedOnChain) : "–"} accent />
            <Stat label="USDC stolen" value="0.00" />
            <Stat label="Flagged addresses" value={i ? String(i.flagged.length) : "–"} />
            <div className="col-span-3 flex flex-wrap items-center gap-x-4 gap-y-1 bg-surface px-3 py-2 text-xs text-muted">
              <span>
                Contract{" "}
                <a className="num text-fg hover:text-accent" href={i ? EXPLORER_ACCOUNT(i.contract) : "#"} target="_blank" rel="noreferrer">
                  {i?.contract ?? "…"}
                </a>
              </span>
              <span>
                Network <span className="num text-fg">{i?.network ?? "…"}</span>
              </span>
              <span>
                Model <span className="num text-fg">{i?.extractor ?? "…"}</span>
              </span>
            </div>
          </div>
        </section>

        {info.error && <div className="mt-6"><ErrorNote error={info.error} /></div>}

        {/* Attacks */}
        <section className="mt-10 grid gap-3 md:grid-cols-3">
          {(i?.presets ?? PLACEHOLDER).map((p) => {
            const Icon = PRESET_ICON[p.id] ?? Swords;
            return (
              <button
                key={p.id}
                disabled={!!busy || !i}
                onClick={() => go(p.id, () => attackApi.preset(p.id))}
                className="group flex flex-col rounded-lg border border-border bg-surface p-4 text-left transition hover:border-danger/40 hover:shadow-[0_0_0_3px_var(--color-danger-soft)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div className="flex items-center justify-between">
                  <span className="grid h-8 w-8 place-items-center rounded-md bg-danger-soft text-danger">
                    <Icon className="h-4 w-4" />
                  </span>
                  {busy === p.id ? <Spinner className="text-danger" /> : <span className="text-xs font-medium text-danger opacity-0 transition group-hover:opacity-100">Launch →</span>}
                </div>
                <div className="mt-3 text-[15px] font-semibold">{p.title}</div>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">{p.blurb}</p>
              </button>
            );
          })}
        </section>

        <section className="mt-3 grid gap-3 md:grid-cols-[1.4fr_1fr]">
          <form
            className="rounded-lg border border-border bg-surface p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void go("direct", () => attackApi.direct(account.trim().toLowerCase(), amount.trim()));
            }}
          >
            <div className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-md bg-violet-soft text-violet">
                <Bot className="h-4 w-4" />
              </span>
              <div>
                <div className="text-[15px] font-semibold">Rogue agent</div>
                <div className="text-[13px] text-muted">Skip the invoice, the AI and the rules. The agent pays whoever you say.</div>
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Input value={account} onChange={(e) => setAccount(e.target.value)} className="num sm:flex-1" spellCheck={false} autoCapitalize="off" aria-label="Your NEAR account" />
              <div className="relative sm:w-36">
                <Input value={amount} onChange={(e) => setAmount(e.target.value)} className="num pr-14" inputMode="decimal" aria-label="Amount" />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">USDC</span>
              </div>
              <Button type="submit" variant="danger" loading={busy === "direct"} disabled={!!busy || !i}>
                <Swords className="h-3.5 w-3.5" /> Pay me
              </Button>
            </div>
          </form>

          <div className="flex flex-col rounded-lg border border-dashed border-border-strong bg-surface p-4">
            <div className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-md bg-surface-2 text-muted">
                <Upload className="h-4 w-4" />
              </span>
              <div>
                <div className="text-[15px] font-semibold">Bring your own invoice</div>
                <div className="text-[13px] text-muted">Craft a PDF and upload it (text-based, max 2 MB).</div>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void go("upload", () => attackApi.upload(f));
              }}
            />
            <Button variant="secondary" className="mt-3" loading={busy === "upload"} disabled={!!busy || !i} onClick={() => fileRef.current?.click()}>
              Choose PDF{i ? ` · ${i.limits.uploadsLeftToday} left today` : ""}
            </Button>
          </div>
        </section>

        {/* Result + side */}
        <section ref={resultRef} className="mt-8 grid scroll-mt-6 gap-5 lg:grid-cols-[1fr_340px]">
          <div className="min-w-0">
            {err ? (
              <ErrorNote error={err} />
            ) : busy ? (
              <RunningCard />
            ) : run ? (
              <RunCard run={run} />
            ) : (
              <div className="grid min-h-[260px] place-items-center rounded-lg border border-dashed border-border-strong bg-surface/60 p-8 text-center">
                <div>
                  <Swords className="mx-auto h-6 w-6 text-faint" />
                  <div className="mt-2 text-[14px] font-medium">Pick an attack</div>
                  <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted">You&apos;ll see each check it went through, and the failed transaction on the NEAR explorer.</p>
                </div>
              </div>
            )}
          </div>

          <aside className="space-y-5">
            <div className="rounded-lg border border-border bg-surface">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <div className="text-[13px] font-semibold">Flagged addresses</div>
                <Pill tone="danger" dot pulse>
                  live
                </Pill>
              </div>
              {i?.flagged.length ? (
                <ul className="divide-y divide-border">
                  {i.flagged.slice(0, 8).map((f) => (
                    <li key={f.id} className="px-4 py-2 text-xs">
                      <div className="num truncate text-[13px] text-fg">{f.account}</div>
                      <div className="text-muted">
                        {f.reason.replace(/_/g, " ").toLowerCase()}
                        {f.amount ? ` · ${formatUsdc(f.amount)} USDC` : ""} · {f.hits}× · {timeAgo(f.lastSeen)}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="px-4 py-3 text-[13px] text-muted">Nothing yet. Be the first.</div>
              )}
              <div className="border-t border-border px-4 py-2.5 text-xs text-muted">
                If anyone later tries to register one of these as a payee, the dashboard warns them and asks for confirmation first.
              </div>
            </div>
            <div className="rounded-lg border border-border bg-surface px-4 py-3 text-xs leading-relaxed text-muted">
              <div className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-fg">
                <ShieldCheck className="h-3.5 w-3.5 text-accent" /> Why this is safe to leave open
              </div>
              Judge mode only sends a payment when the contract is sure to refuse it: the payee isn&apos;t allowlisted, or the invoice was already paid. It checks the chain right before every send. An attack aimed at a real supplier is stopped before it&apos;s sent, and nothing is saved as an invoice.
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}

const PLACEHOLDER = [
  { id: "tampered-payee", title: "Swapped payout account", blurb: "…" },
  { id: "prompt-injection", title: "Prompt injection", blurb: "…" },
  { id: "duplicate", title: "Pay the same invoice twice", blurb: "…" },
];

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-surface px-3 py-3">
      <div className={cn("num text-[22px] font-semibold tracking-tight", accent && "text-accent")}>{value}</div>
      <div className="text-[11px] leading-tight text-muted">{label}</div>
    </div>
  );
}

function RunningCard() {
  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="flex items-center gap-2 text-[14px] font-medium">
        <Spinner className="text-danger" /> Attacking acme.payables.testnet…
      </div>
      <p className="mt-1 text-[13px] text-muted">Reading the invoice, running the checks, then sending a transaction and waiting for it to finalize (about 5 s).</p>
      <div className="mt-4 space-y-2">
        {[0, 1, 2, 3].map((n) => (
          <div key={n} className="skeleton h-11 rounded-md" style={{ animationDelay: `${n * 120}ms` }} />
        ))}
      </div>
    </div>
  );
}

function RunCard({ run }: { run: AttackRun }) {
  const refused = run.verdict === "refused_on_chain";
  const contract = run.steps.find((s) => s.key === "contract");
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className={cn("flex items-start gap-3 border-b px-5 py-4", refused ? "border-ok/25 bg-ok-soft" : "border-warn/25 bg-warn-soft")}>
        {refused ? <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-ok" /> : <Ban className="mt-0.5 h-5 w-5 shrink-0 text-warn" />}
        <div className="min-w-0 flex-1">
          <div className={cn("text-[15px] font-semibold", refused ? "text-ok" : "text-warn")}>{refused ? "Attack failed. No USDC moved." : run.headline}</div>
          <div className="mt-0.5 text-[13px] text-muted">{refused ? run.headline : "Judge mode only sends payments the contract is certain to refuse."}</div>
        </div>
        {contract?.explorerUrl && (
          <a href={contract.explorerUrl} target="_blank" rel="noreferrer" className={buttonClass("secondary", "sm", "shrink-0")}>
            <ExternalLink className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Failed tx</span> <Mono>{shortHash(contract.txHash)}</Mono>
          </a>
        )}
      </div>
      <ol className="relative px-5 py-4">
        {run.steps.map((s, idx) => {
          const Icon = STEP_ICON[s.key];
          const st = STATUS_STYLE[s.status];
          const last = idx === run.steps.length - 1;
          return (
            <li key={idx} className="relative flex gap-3 pb-4 last:pb-0">
              {!last && <span className="absolute left-[15px] top-8 h-[calc(100%-24px)] w-px bg-border" />}
              <span className={cn("relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full border", st.ring)}>
                <Icon className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1 pt-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold">{s.title}</span>
                  {st.label && (
                    <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide", s.status === "block" ? "text-danger" : s.status === "pass" ? "text-ok" : "text-warn")}>
                      <st.icon className="h-3 w-3" /> {st.label}
                    </span>
                  )}
                </div>
                <p className={cn("mt-0.5 break-words text-[13px]", s.key === "contract" && s.status === "block" ? "text-fg" : "text-muted")}>{s.detail}</p>
                {s.key === "rules" && Array.isArray(s.data?.flags) && (s.data.flags as { code: string; severity: string }[]).length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {(s.data.flags as { code: string; severity: string }[]).map((f, n) => (
                      <Pill key={n} tone={f.severity === "block" ? "danger" : f.severity === "warn" ? "warn" : "info"}>
                        {f.code}
                      </Pill>
                    ))}
                  </div>
                )}
                {s.txHash && (
                  <a href={s.explorerUrl ?? "#"} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-accent hover:underline">
                    tx <Mono>{shortHash(s.txHash, 10)}</Mono> <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
