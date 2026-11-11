"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { FileUp, FileText, Lock, X } from "lucide-react";
import { SampleInvoices } from "@/components/sample-invoices";
import { Button, Card, ErrorNote, Field, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { usePayees } from "@/lib/hooks";
import { cn } from "@/lib/format";

const MAX_MB = 10;

export default function PortalUploadPage() {
  const router = useRouter();
  const { data: payees } = usePayees();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [payeeId, setPayeeId] = useState("");
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const pick = (f: File | undefined | null) => {
    setErr(null);
    if (!f) return;
    if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) return setErr(new Error("Please upload a PDF invoice."));
    if (f.size > MAX_MB * 1024 * 1024) return setErr(new Error(`PDF must be under ${MAX_MB} MB.`));
    setFile(f);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Submit an invoice</h1>
        <p className="mt-1.5 text-sm text-muted">Upload your PDF. It&apos;s read by an AI agent, checked against Acme&apos;s purchase orders, and paid in USDC to your registered NEAR account.</p>
      </div>

      <Card className="p-4 sm:p-6">
        <div className="space-y-5">
          <div
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              pick(e.dataTransfer.files?.[0]);
            }}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring",
              drag ? "border-accent bg-accent-soft" : "border-border-strong hover:border-accent/60 hover:bg-surface-2/50",
            )}
          >
            <input ref={inputRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
            <div className={cn("mb-3 grid h-11 w-11 place-items-center rounded-full", drag ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted")}>
              <FileUp className="h-5 w-5" />
            </div>
            <p className="text-sm font-medium">{drag ? "Drop to upload" : "Drag your invoice PDF here"}</p>
            <p className="mt-1 text-xs text-muted">or click to browse · PDF up to {MAX_MB} MB</p>
          </div>

          {file && (
            <div className="flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2.5">
              <FileText className="h-5 w-5 shrink-0 text-danger" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{file.name}</div>
                <div className="num text-[11.5px] text-muted">{(file.size / 1024).toFixed(1)} KB</div>
              </div>
              <button onClick={() => setFile(null)} className="rounded p-1 text-muted hover:bg-surface hover:text-fg" aria-label="Remove file">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <Field label="Who are you? (optional)" htmlFor="payee" hint="Helps match your invoice. Leave blank and we'll match by name and PO.">
            <Select id="payee" value={payeeId} onChange={(e) => setPayeeId(e.target.value)}>
              <option value="">Detect from invoice</option>
              {payees?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>

          <ErrorNote error={err} />

          <Button
            className="w-full"
            disabled={!file}
            loading={busy}
            onClick={async () => {
              if (!file) return;
              setBusy(true);
              setErr(null);
              try {
                const inv = await api.uploadInvoice(file, payeeId || undefined);
                router.push(`/portal/invoices/${inv.id}`);
              } catch (e) {
                setErr(e);
                setBusy(false);
              }
            }}
          >
            Submit invoice
          </Button>
        </div>
      </Card>

      <SampleInvoices />

      <div className="flex items-start gap-2 text-xs text-muted">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          Payment always goes to the NEAR account Acme registered for you, never to an account written on the invoice. To change it, contact Acme; changes require approval by their DAO.
        </p>
      </div>
    </div>
  );
}
