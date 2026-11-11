import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, UnrecoverableError } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { ActivityService } from '../activity/activity.service';
import { formatUsdc } from '../common/amount';
import { config } from '../config';
import { ExtractionValidationError, ExtractorService } from '../extraction/extractor.service';
import { evaluateRules, PayeeRef, PoRef, RiskFlag } from '../extraction/rules';
import { FlaggedService } from '../flagged/flagged.service';
import type { Invoice, InvoiceStatus } from '../generated/prisma/client';
import { ChainInvoice, ContractRejectedError, NearService, PaymentResult } from '../near/near.service';
import { NotifierService } from '../notify/notifier.service';
import { PrismaService } from '../prisma/prisma.service';
import { EXTRACT_QUEUE, ExtractJob, NOTIFY_QUEUE, NotifyJob, NotifyType, PAY_QUEUE, PayJob } from '../queues/queue-names';
import { sha256Hex, StorageService } from '../storage/storage.service';

/** Statuses from which the agent may submit `request_payment`. */
const PAYABLE: InvoiceStatus[] = ['scheduled', 'needs_review'];

/** Orchestrates invoice lifecycle: extract → rules → schedule → pay → chain status → notify. */
@Injectable()
export class PipelineService {
  private readonly log = new Logger('Pipeline');

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly extractor: ExtractorService,
    private readonly near: NearService,
    private readonly activity: ActivityService,
    private readonly notifier: NotifierService,
    private readonly flagged: FlaggedService,
    @InjectQueue(EXTRACT_QUEUE) private readonly extractQueue: Queue<ExtractJob>,
    @InjectQueue(PAY_QUEUE) private readonly payQueue: Queue<PayJob>,
    @InjectQueue(NOTIFY_QUEUE) private readonly notifyQueue: Queue<NotifyJob>,
  ) {}

  // ------------------------------------------------------------------ intake

  /** Stores a received PDF, records it and queues extraction. Shared by portal uploads and sample invoices. */
  async ingest(companyId: string, bytes: Uint8Array, fileName: string, declaredPayeeId?: string, extra: Record<string, unknown> = {}) {
    const hash = sha256Hex(bytes);
    const key = `invoices/${companyId}/${hash.slice(0, 16)}-${randomUUID()}.pdf`;
    await this.storage.put(key, bytes);
    const invoice = await this.prisma.invoice.create({
      data: { companyId, pdfKey: key, pdfHash: hash, status: 'received', payeeId: declaredPayeeId || null, extracted: {}, riskFlags: [] },
    });
    await this.activity.record(
      companyId,
      'received',
      `Invoice PDF received (${fileName}, ${bytes.length} bytes)`,
      { fileName, sha256: hash, storage: this.storage.mode, ...extra },
      invoice.id,
    );
    await this.enqueueExtract(invoice.id, declaredPayeeId || undefined);
    return invoice;
  }

  async enqueueExtract(invoiceId: string, declaredPayeeId?: string) {
    await this.extractQueue.add('extract', { invoiceId, declaredPayeeId }, { jobId: `extract-${invoiceId}` });
  }

  // ------------------------------------------------------------------ extract

  async runExtraction({ invoiceId, declaredPayeeId }: ExtractJob, attempt: number, maxAttempts: number) {
    const invoice = await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (!['received', 'extracting'].includes(invoice.status)) {
      this.log.log(`extract ${invoiceId}: already ${invoice.status}, skipping`);
      return;
    }
    await this.prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'extracting' } });
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: invoice.companyId } });

    let result;
    try {
      const pdf = await this.storage.get(invoice.pdfKey);
      result = await this.extractor.extract(pdf);
    } catch (e) {
      const permanent = e instanceof ExtractionValidationError;
      if (permanent || attempt >= maxAttempts) {
        const flags: RiskFlag[] = [];
        await this.prisma.invoice.update({
          where: { id: invoiceId },
          data: { status: 'needs_review', riskFlags: flags as never, extracted: { error: (e as Error).message, raw: (e as ExtractionValidationError).raw ?? null } as never },
        });
        await this.activity.record(company.id, 'extraction_failed', `Extraction failed: ${(e as Error).message}`, {}, invoiceId);
        if (permanent) throw new UnrecoverableError((e as Error).message);
      }
      throw e;
    }

    const { extracted, text } = result;
    const [payees, pos, dupHash] = await Promise.all([
      this.prisma.payee.findMany({ where: { companyId: company.id } }),
      this.prisma.purchaseOrder.findMany({ where: { companyId: company.id } }),
      this.prisma.invoice.findMany({ where: { companyId: company.id, pdfHash: invoice.pdfHash, id: { not: invoiceId } }, select: { id: true } }),
    ]);

    const rules = evaluateRules({
      extracted,
      rawText: text,
      payees: payees as PayeeRef[],
      purchaseOrders: pos as PoRef[],
      declaredPayeeId,
      autoPayLimit: company.autoPayLimit,
      duplicateHashInvoiceIds: dupHash.map((d) => d.id),
      duplicateNumberInvoiceIds: [],
    });
    // Duplicate-number check needs the resolved payee, so run it after resolution.
    if (rules.payee) {
      const dupNum = await this.prisma.invoice.findMany({
        where: {
          companyId: company.id,
          payeeId: rules.payee.id,
          number: extracted.invoiceNumber,
          id: { not: invoiceId },
          status: { notIn: ['rejected'] },
        },
        select: { id: true },
      });
      if (dupNum.length) {
        Object.assign(
          rules,
          evaluateRules({
            extracted,
            rawText: text,
            payees: payees as PayeeRef[],
            purchaseOrders: pos as PoRef[],
            declaredPayeeId,
            autoPayLimit: company.autoPayLimit,
            duplicateHashInvoiceIds: dupHash.map((d) => d.id),
            duplicateNumberInvoiceIds: dupNum.map((d) => d.id),
          }),
        );
      }
    }

    const updated = await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        number: extracted.invoiceNumber,
        amount: extracted.amount,
        currency: extracted.currency,
        dueDate: new Date(`${extracted.dueDate}T00:00:00Z`),
        payeeId: rules.payee?.id ?? null,
        poId: rules.po?.id ?? null,
        extracted: { ...extracted, source: result.source, model: result.model ?? null, textPreview: text.slice(0, 2000) } as never,
        riskFlags: rules.flags as never,
        status: rules.status,
      },
    });

    await this.activity.record(
      company.id,
      'extracted',
      `Extracted ${extracted.invoiceNumber} from ${extracted.payeeName}: ${formatUsdc(extracted.amount)} ${extracted.currency}, due ${extracted.dueDate} (${result.source})`,
      { source: result.source, flags: rules.flags.map((f) => f.code) },
      invoiceId,
    );
    for (const f of rules.flags) {
      await this.activity.record(company.id, `risk_${f.code.toLowerCase()}`, f.message, { code: f.code, severity: f.severity }, invoiceId);
    }

    if (rules.status === 'blocked') {
      for (const t of FlaggedService.targetsFromFlags(rules.flags, extracted.amount)) {
        const seen = await this.flagged.find(company.id, t.account);
        await this.flagged.record(company.id, { ...t, source: 'invoice', invoiceId });
        await this.activity.record(
          company.id,
          'address_flagged',
          seen ? `${t.account} was already flagged (${seen.hits} earlier attempt${seen.hits === 1 ? '' : 's'})` : `${t.account} added to flagged addresses`,
          { account: t.account, reason: t.reason },
          invoiceId,
        );
      }
      await this.activity.record(company.id, 'blocked', 'Invoice blocked by rule checks', {}, invoiceId);
      await this.enqueueNotify('blocked', invoiceId);
    } else if (rules.status === 'scheduled') {
      await this.schedulePay(updated);
    } else {
      await this.activity.record(company.id, 'needs_review', 'Invoice needs human review before payment (use pay-now to approve)', {}, invoiceId);
    }
  }

  async schedulePay(invoice: Invoice) {
    const due = invoice.dueDate?.getTime() ?? Date.now();
    let runAt = due;
    if (config.payDelayOverrideSeconds !== undefined) runAt = Math.min(due, Date.now() + config.payDelayOverrideSeconds * 1000);
    const delay = Math.max(0, runAt - Date.now());
    await this.payQueue.add('pay', { invoiceId: invoice.id, trigger: 'due_date' }, { jobId: `pay-${invoice.id}`, delay });
    await this.activity.record(
      invoice.companyId,
      'scheduled',
      `Payment scheduled for ${new Date(runAt).toISOString()}`,
      { runAt: new Date(runAt).toISOString(), delayMs: delay },
      invoice.id,
    );
  }

  async payNow(invoice: Invoice, force: boolean) {
    // Drop a pending delayed job, then enqueue an immediate one.
    const existing = await this.payQueue.getJob(`pay-${invoice.id}`);
    if (existing && (await existing.isDelayed())) await existing.remove();
    await this.payQueue.add('pay', { invoiceId: invoice.id, trigger: 'pay_now', force }, { jobId: `pay-${invoice.id}-now-${Date.now()}` });
    await this.activity.record(invoice.companyId, 'pay_now', force ? 'Forced payment requested (demo)' : 'Pay now requested', { force }, invoice.id);
  }

  // ------------------------------------------------------------------ pay

  async runPay(job: PayJob) {
    const invoice = await this.prisma.invoice.findUniqueOrThrow({ where: { id: job.invoiceId }, include: { payee: true } });
    const forced = !!job.force && invoice.status === 'blocked';
    if (!forced && !PAYABLE.includes(invoice.status)) {
      this.log.log(`pay ${invoice.id}: status ${invoice.status}, nothing to do`);
      return { skipped: invoice.status };
    }
    if (!invoice.amount || !invoice.dueDate) throw new UnrecoverableError('Invoice has not been extracted');

    // Normal path: payee is ALWAYS the allowlisted account. Forced path (demo) mimics a compromised agent
    // that obeys the invoice, to show the contract refusing it.
    let payeeAccount = invoice.payee?.nearAccountId;
    let amount = invoice.amount;
    if (forced) {
      const flags = (invoice.riskFlags ?? []) as unknown as RiskFlag[];
      const mismatch = flags.find((f) => f.code === 'PAYEE_MISMATCH' && f.data?.claimedAccount);
      const injection = flags.find((f) => f.code === 'PROMPT_INJECTION' && f.data?.target);
      if (injection) {
        const t = injection.data!.target as { account: string; amount?: string };
        payeeAccount = t.account;
        amount = t.amount ?? amount;
      } else if (mismatch) {
        payeeAccount = String(mismatch.data!.claimedAccount);
      }
    }
    if (!payeeAccount) throw new UnrecoverableError('No allowlisted payee resolved for invoice');

    if (!forced) await this.prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'paying' } });
    await this.activity.record(
      invoice.companyId,
      'payment_requested',
      `Agent calling request_payment(${formatUsdc(amount)} USDC → ${payeeAccount})${this.near.simulated ? ' [simulated chain]' : ''}`,
      { payee: payeeAccount, amount, forced },
      invoice.id,
    );

    let result: PaymentResult;
    try {
      result = await this.near.requestPayment({
        invoice_id: invoice.id,
        payee: payeeAccount,
        amount,
        invoice_hash: invoice.pdfHash,
        due_date: invoice.dueDate.toISOString().slice(0, 10),
      });
    } catch (e) {
      if (e instanceof ContractRejectedError) {
        const status: InvoiceStatus = forced ? 'blocked' : 'failed';
        await this.prisma.invoice.update({ where: { id: invoice.id }, data: { status, txHash: e.txHash ?? invoice.txHash } });
        await this.activity.record(invoice.companyId, 'contract_refused', `Policy contract refused payment: ${e.message}`, { txHash: e.txHash ?? null, forced }, invoice.id);
        await this.enqueueNotify(forced ? 'blocked' : 'failed', invoice.id);
        throw new UnrecoverableError(e.message);
      }
      // Network/RPC problem: leave as scheduled so the retry can resubmit.
      await this.prisma.invoice.update({ where: { id: invoice.id }, data: { status: invoice.status } });
      throw e;
    }

    await this.applyPaymentResult(invoice.id, result);
    return { status: result.status, txHash: result.txHash };
  }

  async applyPaymentResult(invoiceId: string, r: PaymentResult) {
    const inv = await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: r.status,
        txHash: r.txHash,
        daoProposalId: r.proposalId ?? undefined,
        paidAt: r.status === 'paid' ? new Date() : undefined,
      },
    });
    const events = r.events.map((e) => e.event);
    const base = { txHash: r.txHash, events, simulated: r.simulated, explorerUrl: this.near.explorerTxUrl(r.txHash) };
    switch (r.status) {
      case 'paid':
        await this.activity.record(inv.companyId, 'paid', `Paid ${formatUsdc(inv.amount!)} USDC`, base, invoiceId);
        await this.enqueueNotify('paid', invoiceId);
        break;
      case 'pending_approval':
        await this.activity.record(
          inv.companyId,
          'escalated',
          `Above policy limits; DAO proposal #${r.proposalId} opened`,
          { ...base, proposalId: r.proposalId },
          invoiceId,
        );
        await this.enqueueNotify('approval_needed', invoiceId);
        break;
      case 'failed':
        await this.activity.record(inv.companyId, 'failed', 'Token transfer failed', base, invoiceId);
        await this.enqueueNotify('failed', invoiceId);
        break;
      case 'rejected':
        await this.activity.record(inv.companyId, 'rejected', 'Payment rejected', base, invoiceId);
        break;
      default:
        await this.activity.record(inv.companyId, 'submitted', 'Payment submitted; awaiting callback', base, invoiceId);
    }
  }

  /** Reconcile an invoice with its on-chain state (used by the chain-sync poller). */
  async syncFromChain(invoiceId: string, chain: ChainInvoice) {
    const inv = await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (chain.status === inv.status) return;
    if (!['paid', 'failed', 'rejected'].includes(chain.status)) return;
    await this.applyPaymentResult(invoiceId, {
      status: chain.status,
      txHash: inv.txHash ?? '',
      logs: [],
      events: [],
      simulated: this.near.simulated,
      proposalId: inv.daoProposalId ?? undefined,
    });
  }

  // ------------------------------------------------------------------ notify

  async enqueueNotify(type: NotifyType, invoiceId: string) {
    await this.notifyQueue.add('notify', { type, invoiceId });
  }

  async runNotify(job: NotifyJob) {
    const invoice = await this.prisma.invoice.findUniqueOrThrow({ where: { id: job.invoiceId }, include: { payee: true, company: true } });
    const res = await this.notifier.send({ type: job.type, invoice, payeeName: invoice.payee?.name, company: invoice.company });
    await this.activity.record(invoice.companyId, 'notified', `Notification "${job.type}" (telegram: ${res.telegram}, email: ${res.email})`, { type: job.type, ...res }, invoice.id);
    return res;
  }
}
