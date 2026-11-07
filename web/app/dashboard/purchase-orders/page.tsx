"use client";

import { useState } from "react";
import { FileText, Plus } from "lucide-react";
import { Button, Card, Dialog, EmptyState, ErrorNote, Field, Input, PageHeader, Select, Skeleton } from "@/components/ui";
import { Amount, Pill } from "@/components/status";
import { api } from "@/lib/api";
import { useInvoices, usePayees, usePurchaseOrders, useRefreshAll } from "@/lib/hooks";
import { cn, formatUsdc, parseUsdc, ratio } from "@/lib/format";

function CreatePoDialog({ open, onClose, nextNumber }: { open: boolean; onClose: () => void; nextNumber: string }) {
  const { data: payees } = usePayees();
  const refresh = useRefreshAll();
  const [payeeId, setPayeeId] = useState("");
  const [number, setNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const num = number || nextNumber;
  const base = amount ? parseUsdc(amount) : null;
  const amountErr = amount && (!base || base === "0") ? "Enter a positive USDC amount (max 6 decimals)" : null;
  const valid = payeeId && num && base && base !== "0" && description.trim();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New purchase order"
      description="Invoices are matched against open POs; overages and missing POs are flagged."
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" type="submit" form="create-po" loading={busy} disabled={touched && !valid}>
            Create PO
          </Button>
        </>
      }
    >
      <form
        id="create-po"
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setTouched(true);
          if (!valid) return;
          setBusy(true);
          setErr(null);
          try {
            await api.createPurchaseOrder({ payeeId, number: num.trim(), amount: base!, description: description.trim() });
            refresh();
            setPayeeId("");
            setNumber("");
            setAmount("");
            setDescription("");
            setTouched(false);
            onClose();
          } catch (e) {
            setErr(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Payee" htmlFor="po-payee" error={touched && !payeeId ? "Required" : null}>
          <Select id="po-payee" value={payeeId} onChange={(e) => setPayeeId(e.target.value)}>
            <option value="">Select a payee…</option>
            {payees?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.nearAccountId})
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="PO number" htmlFor="po-num">
            <Input id="po-num" value={number} onChange={(e) => setNumber(e.target.value)} placeholder={nextNumber} className="num" />
          </Field>
          <Field label="Amount (USDC)" htmlFor="po-amt" error={(touched && !amount ? "Required" : null) ?? amountErr}>
            <Input id="po-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="4.00" className="num" />
          </Field>
        </div>
        <Field label="Description" htmlFor="po-desc" error={touched && !description.trim() ? "Required" : null}>
          <Input id="po-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Brand refresh — Q4 sprint 3" />
        </Field>
        <ErrorNote error={err} />
      </form>
    </Dialog>
  );
}

export default function PurchaseOrdersPage() {
  const { data: pos, isLoading, error } = usePurchaseOrders();
  const { data: payees } = usePayees();
  const { data: invoices } = useInvoices();
  const [open, setOpen] = useState(false);

  const nextNumber = (() => {
    const nums = (pos ?? []).map((p) => parseInt(p.number.replace(/\D/g, ""), 10)).filter((n) => !isNaN(n));
    return `PO-${(nums.length ? Math.max(...nums) : 1000) + 1}`;
  })();

  const invoicedFor = (poId: string) =>
    (invoices ?? [])
      .filter((i) => i.poId === poId && !["blocked", "rejected", "failed"].includes(i.status))
      .reduce((s, i) => s + BigInt(i.amount || "0"), BigInt(0))
      .toString();

  return (
    <>
      <PageHeader
        title="Purchase orders"
        description="Approved spend. Invoices without a PO, or above it, go to review."
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> New PO
          </Button>
        }
      />
      <ErrorNote error={error} />
      <Card className="overflow-hidden">
        {isLoading && !pos ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-6" />
            ))}
          </div>
        ) : !pos?.length ? (
          <EmptyState icon={<FileText className="h-6 w-6" />} title="No purchase orders" description="Create a PO so incoming invoices can be matched automatically." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-[11.5px] uppercase tracking-wide text-faint">
                  <th className="px-4 py-2 font-medium">PO</th>
                  <th className="px-3 py-2 font-medium">Payee</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="w-40 px-3 py-2 font-medium">Invoiced</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pos.map((po) => {
                  const inv = invoicedFor(po.id);
                  const r = ratio(inv, po.amount);
                  const payee = po.payee ?? payees?.find((p) => p.id === po.payeeId);
                  return (
                    <tr key={po.id} className={cn(po.status === "closed" && "text-muted")}>
                      <td className="num whitespace-nowrap px-4 py-2.5 font-medium">{po.number}</td>
                      <td className="whitespace-nowrap px-3 py-2.5">{payee?.name ?? "—"}</td>
                      <td className="max-w-[260px] truncate px-3 py-2.5 text-muted" title={po.description}>
                        {po.description}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <Amount value={po.amount} unit={false} />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                            <div className={cn("h-full rounded-full", r > 1 ? "bg-warn" : "bg-accent")} style={{ width: `${Math.min(100, r * 100)}%` }} />
                          </div>
                          <span className={cn("num w-12 text-right text-[11.5px]", r > 1 ? "text-warn" : "text-muted")}>{Math.round(r * 100)}%</span>
                        </div>
                        <div className="num mt-0.5 text-[11px] text-faint">{formatUsdc(inv)}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        <Pill tone={po.status === "open" ? "accent" : "neutral"} dot>
                          {po.status === "open" ? "Open" : "Closed"}
                        </Pill>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <CreatePoDialog open={open} onClose={() => setOpen(false)} nextNumber={nextNumber} />
    </>
  );
}
