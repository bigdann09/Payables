"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Download, FlaskConical } from "lucide-react";
import { Button, Card, CardHeader, ErrorNote } from "@/components/ui";
import { Pill } from "@/components/status";
import { samplesApi } from "@/lib/api";
import { useSamples } from "@/lib/hooks";
import type { SampleInvoice } from "@/lib/types";

const TONE: Record<SampleInvoice["id"], "ok" | "danger" | "violet"> = {
  clean: "ok",
  tampered: "danger",
  injection: "danger",
  "over-limit": "violet",
};
const OUTCOME: Record<SampleInvoice["id"], string> = {
  clean: "Pays",
  tampered: "Blocked",
  injection: "Blocked",
  "over-limit": "DAO vote",
};

/** One-click sample invoices so visitors can watch the agent without making a PDF. */
export function SampleInvoices() {
  const router = useRouter();
  const { data } = useSamples();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-accent" /> No invoice handy? Try a sample
          </span>
        }
        description="Each one is a fresh PDF from one of Acme's real vendors. Submit it straight away, or download it and drop it in above."
      />
      <ul className="divide-y divide-border border-t border-border">
        {(data?.samples ?? []).map((s) => (
          <li key={s.id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-medium">{s.title}</span>
                <Pill tone={TONE[s.id]}>{OUTCOME[s.id]}</Pill>
              </div>
              <p className="mt-0.5 text-xs text-muted">{s.expected}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={!!busy}
                onClick={() => run(`dl-${s.id}`, () => samplesApi.download(s.id))}
                aria-label={`Download ${s.title} PDF`}
                title="Download PDF"
                loading={busy === `dl-${s.id}`}
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!!busy}
                loading={busy === s.id}
                onClick={() =>
                  run(s.id, async () => {
                    const inv = await samplesApi.submit(s.id);
                    router.push(`/portal/invoices/${inv.id}`);
                  })
                }
              >
                Submit sample
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {err ? (
        <div className="border-t border-border px-4 py-3">
          <ErrorNote error={err} />
        </div>
      ) : null}
      <p className="border-t border-border px-4 py-2.5 text-[11.5px] text-faint">
        Payments are real USDC transfers on NEAR testnet to the vendor&apos;s allowlisted account, capped by the contract&apos;s daily limit.
      </p>
    </Card>
  );
}
