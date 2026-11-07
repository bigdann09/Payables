/**
 * Deterministic stand-in for the NEAR AI model, used when NEAR_AI_API_KEY is missing.
 * Understands a simple "Label: value" invoice text format (what the demo fixtures contain):
 *
 *   Invoice Number: INV-1   From: Acme Supplies   NEAR Account: x.testnet   PO Number: PO-1
 *   Due Date: 2026-11-12    Item: Design work | 1 | 1,500.00 | 1,500.00     Total: 1,850.00 USDC
 *
 * Works on text whose line breaks were lost during PDF extraction, by splitting on known labels.
 * Like the real model, it only reads the labelled fields; free text (e.g. notes) is ignored.
 */
const LABELS: Record<string, string> = {
  'invoice number': 'invoiceNumber',
  'invoice no': 'invoiceNumber',
  'invoice #': 'invoiceNumber',
  from: 'payeeName',
  supplier: 'payeeName',
  vendor: 'payeeName',
  'payee': 'payeeName',
  'near account': 'payeeNearAccount',
  'pay to account': 'payeeNearAccount',
  'po number': 'poNumber',
  'purchase order': 'poNumber',
  'due date': 'dueDate',
  total: 'amount',
  'amount due': 'amount',
  currency: 'currency',
  item: 'lineItem',
  'bill to': '_ignore',
  'issue date': '_ignore',
  notes: '_ignore',
  'payment terms': '_ignore',
};

const LABEL_RE = new RegExp(
  `(?:^|\\s|\\n)(${Object.keys(LABELS)
    .sort((a, b) => b.length - a.length)
    .map((l) => l.replace(/[#]/g, '\\$&'))
    .join('|')})\\s*:`,
  'gi',
);

export function fakeExtract(text: string): Record<string, unknown> {
  const hits: { key: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(LABEL_RE)) {
    hits.push({ key: LABELS[m[1].toLowerCase()], start: m.index!, end: m.index! + m[0].length });
  }
  const out: Record<string, unknown> = { lineItems: [] as unknown[] };
  hits.forEach((h, i) => {
    const raw = text.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : text.length);
    const value = raw.split('\n')[0].trim();
    if (h.key === '_ignore' || !value) return;
    if (h.key === 'lineItem') {
      const [description, quantity, unitPrice, amount] = value.split('|').map((s) => s.trim());
      (out.lineItems as unknown[]).push({ description, quantity: Number(quantity), unitPrice, amount: amount ?? unitPrice });
      return;
    }
    if (h.key === 'amount') {
      const m = /([\d][\d,]*(?:\.\d+)?)\s*([A-Z]{3,4})?/.exec(value);
      if (m) {
        out.amount = m[1];
        if (m[2] && !out.currency) out.currency = m[2];
      }
      return;
    }
    if (out[h.key] === undefined) out[h.key] = value;
  });
  if (!out.currency) out.currency = 'USDC';
  return out;
}
