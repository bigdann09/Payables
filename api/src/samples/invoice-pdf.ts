import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/** Plain-text invoice PDF, used by the demo fixtures script and the portal's "try a sample" invoices. */
export interface InvoiceDoc {
  title: string;
  invoiceNumber: string;
  from: string;
  fromAddress: string;
  nearAccount: string;
  /** Empty = no purchase order referenced. */
  poNumber: string;
  issueDate: string;
  dueDate: string;
  items: { description: string; qty: number; unit: string; amount: string }[];
  total: string;
  notes: string[];
}

export async function renderInvoicePdf(f: InvoiceDoc): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${f.invoiceNumber}`);
  doc.setAuthor(f.from);
  doc.setSubject(f.title);
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 790;
  const line = (text: string, opts: { size?: number; bold?: boolean; x?: number; gap?: number } = {}) => {
    page.drawText(text, { x: opts.x ?? 50, y, size: opts.size ?? 11, font: opts.bold ? bold : font, color: rgb(0.1, 0.1, 0.12) });
    y -= opts.gap ?? (opts.size ?? 11) + 7;
  };

  line('INVOICE', { size: 24, bold: true, gap: 34 });
  line(`Invoice Number: ${f.invoiceNumber}`);
  line(`Issue Date: ${f.issueDate}`);
  line(`Due Date: ${f.dueDate}`, { gap: 26 });
  line(`From: ${f.from}`, { bold: true });
  line(f.fromAddress, { size: 9 });
  line(`NEAR Account: ${f.nearAccount}`, { gap: 26 });
  if (f.poNumber) {
    line('Bill To: Acme', { bold: true });
    line(`PO Number: ${f.poNumber}`, { gap: 26 });
  } else {
    line('Bill To: Acme', { bold: true, gap: 26 });
  }
  line('Description | Qty | Unit price | Amount', { bold: true, size: 10 });
  for (const it of f.items) line(`Item: ${it.description} | ${it.qty} | ${it.unit} | ${it.amount}`, { size: 10 });
  y -= 10;
  line(`Total: ${f.total} USDC`, { bold: true, size: 14, gap: 30 });
  line('Payment Terms: Net 10, USDC (NEP-141) on NEAR', { size: 9, gap: 24 });
  line('Notes:', { bold: true, size: 10 });
  for (const n of f.notes) line(n, { size: 9 });
  return doc.save();
}
