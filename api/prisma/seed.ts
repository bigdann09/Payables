/**
 * Demo data: company "Acme" (id = COMPANY_ID, default "acme"), 3 payees, 3 POs and a handful of invoices
 * in varied statuses. Idempotent: wipes the demo company's rows first.
 * Placeholder PDFs for seeded invoices are written to local storage (LOCAL_STORAGE_DIR).
 */
import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { baseEncode } from '@near-js/utils';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PrismaClient } from '../src/generated/prisma/client';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? 'postgresql://payables:payables@localhost:5432/payables' }),
});
const COMPANY_ID = process.env.COMPANY_ID || 'acme';
const STORAGE = resolve(process.env.LOCAL_STORAGE_DIR || '.data/uploads');
const usdc = (n: number) => (BigInt(Math.round(n * 100)) * 10_000n).toString();
const day = 86_400_000;
const fakeTx = () => baseEncode(randomBytes(32));

async function placeholderPdf(key: string, lines: string[]) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((l, i) => page.drawText(l, { x: 50, y: 780 - i * 20, size: i === 0 ? 20 : 11, font }));
  const bytes = await doc.save();
  const path = resolve(STORAGE, key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return createHash('sha256').update(bytes).digest('hex');
}

async function main() {
  await prisma.activityLog.deleteMany({ where: { companyId: COMPANY_ID } });
  await prisma.invoice.deleteMany({ where: { companyId: COMPANY_ID } });
  await prisma.purchaseOrder.deleteMany({ where: { companyId: COMPANY_ID } });
  await prisma.payee.deleteMany({ where: { companyId: COMPANY_ID } });
  await prisma.company.deleteMany({ where: { id: COMPANY_ID } });

  const company = await prisma.company.create({
    data: {
      id: COMPANY_ID,
      name: 'Acme',
      policyContractId: process.env.POLICY_CONTRACT_ID || 'acme.payables.testnet',
      daoId: process.env.DAO_ID || 'acme-dao.sputnik-v2.testnet',
      autoPayLimit: usdc(5),
      dailyCap: usdc(15),
      telegramChatId: process.env.TELEGRAM_CHAT_ID || null,
      notifyEmail: 'finance@acme.example',
    },
  });

  const [northwind, bluepeak, orbit] = await Promise.all(
    [
      { name: 'Northwind Design Studio', email: 'billing@northwind.example', nearAccountId: 'northwind.payables.testnet' },
      { name: 'BluePeak Consulting', email: 'ap@bluepeak.example', nearAccountId: 'bluepeak.payables.testnet' },
      { name: 'Orbit Labs', email: 'invoices@orbitlabs.example', nearAccountId: 'orbit-labs.payables.testnet' },
    ].map((p) => prisma.payee.create({ data: { companyId: company.id, ...p } })),
  );

  const [po1, po2, po3] = await Promise.all([
    prisma.purchaseOrder.create({ data: { companyId: company.id, payeeId: northwind.id, number: 'PO-1001', amount: usdc(10), description: 'Brand refresh and illustrations, Q4' } }),
    prisma.purchaseOrder.create({ data: { companyId: company.id, payeeId: bluepeak.id, number: 'PO-1002', amount: usdc(10), description: 'Tokenomics and governance advisory' } }),
    prisma.purchaseOrder.create({ data: { companyId: company.id, payeeId: orbit.id, number: 'PO-1003', amount: usdc(5), description: 'Smart contract audit follow-up' } }),
  ]);

  const now = Date.now();
  type Seed = {
    number: string; payee: typeof northwind; po?: typeof po1; amount: number; dueInDays: number; status: string;
    flags?: { code: string; severity: string; message: string }[]; tx?: boolean; proposal?: string; paidDaysAgo?: number; createdDaysAgo: number;
  };
  const seeds: Seed[] = [
    { number: 'NW-2026-0118', payee: northwind, po: po1, amount: 1.2, dueInDays: -12, status: 'paid', tx: true, paidDaysAgo: 3, createdDaysAgo: 3 },
    { number: 'ORB-0061', payee: orbit, po: po3, amount: 0.8, dueInDays: -5, status: 'paid', tx: true, paidDaysAgo: 1, createdDaysAgo: 1 },
    { number: 'BP-3290', payee: bluepeak, po: po2, amount: 7.2, dueInDays: 2, status: 'pending_approval', tx: true, proposal: '0', createdDaysAgo: 1,
      flags: [{ code: 'OVER_LIMIT', severity: 'info', message: 'Amount 7.20 USDC is above the auto-pay limit (5.00 USDC); DAO approval required' }] },
    { number: 'NW-2026-0131', payee: northwind, po: po1, amount: 1.5, dueInDays: 6, status: 'scheduled', createdDaysAgo: 0 },
    { number: 'BP-3302', payee: bluepeak, amount: 2, dueInDays: 9, status: 'needs_review', createdDaysAgo: 0,
      flags: [{ code: 'NO_PO', severity: 'warn', message: 'Invoice does not reference a purchase order' }] },
    { number: 'ORB-0070', payee: orbit, po: po3, amount: 2.4, dueInDays: 4, status: 'blocked', createdDaysAgo: 2,
      flags: [{ code: 'PAYEE_MISMATCH', severity: 'block', message: "Invoice asks for payment to orbit-labs-billing.testnet, but Orbit Labs's allowlisted account is orbit-labs.payables.testnet" }] },
  ];
  // On the real chain, skip rows that claim on-chain state (fake tx hashes, a DAO proposal that doesn't exist).
  const onChain = Boolean(process.env.AGENT_PRIVATE_KEY && process.env.OWNER_PRIVATE_KEY);
  const rows = onChain ? seeds.filter((s) => !s.tx) : seeds;

  for (const s of rows) {
    const key = `invoices/${company.id}/seed-${s.number}.pdf`;
    const hash = await placeholderPdf(key, [`INVOICE ${s.number}`, `From: ${s.payee.name}`, `Total: ${s.amount.toFixed(2)} USDC`, '(seeded demo document)']);
    const due = new Date(now + s.dueInDays * day);
    const created = new Date(now - s.createdDaysAgo * day);
    const txHash = s.tx ? fakeTx() : null;
    const inv = await prisma.invoice.create({
      data: {
        companyId: company.id,
        payeeId: s.payee.id,
        poId: s.po?.id ?? null,
        number: s.number,
        amount: usdc(s.amount),
        currency: 'USDC',
        dueDate: new Date(due.toISOString().slice(0, 10)),
        pdfKey: key,
        pdfHash: hash,
        extracted: {
          invoiceNumber: s.number, payeeName: s.payee.name, payeeNearAccount: s.payee.nearAccountId, amount: usdc(s.amount),
          currency: 'USDC', dueDate: due.toISOString().slice(0, 10), poNumber: s.po?.number ?? null, lineItems: [], source: 'seed',
        },
        riskFlags: s.flags ?? [],
        status: s.status as never,
        txHash,
        daoProposalId: s.proposal ?? null,
        paidAt: s.paidDaysAgo !== undefined ? new Date(now - s.paidDaysAgo * day) : null,
        createdAt: created,
      },
    });
    const log = (type: string, message: string, data: object = {}, at = created) =>
      prisma.activityLog.create({ data: { companyId: company.id, invoiceId: inv.id, type, message, data, createdAt: at } });
    await log('received', `Invoice ${s.number} received`);
    await log('extracted', `Extracted ${s.number} from ${s.payee.name}: ${s.amount.toFixed(2)} USDC (seed)`);
    if (s.status === 'paid') await log('paid', `Paid ${s.amount.toFixed(2)} USDC`, { txHash, simulated: true }, new Date(now - s.paidDaysAgo! * day));
    if (s.status === 'pending_approval') await log('escalated', `Above policy limits; DAO proposal #${s.proposal} opened`, { txHash, proposalId: s.proposal });
    if (s.status === 'blocked') await log('blocked', 'Invoice blocked by rule checks');
    if (s.status === 'scheduled') await log('scheduled', 'Payment scheduled for due date');
  }

  console.log(`Seeded company ${company.id} with 3 payees, 3 POs, ${rows.length} invoices`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
