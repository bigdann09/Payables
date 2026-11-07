import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatUsdc } from '../common/amount';
import { config, mocks } from '../config';
import { ExtractionResult, ExtractorService } from '../extraction/extractor.service';
import { evaluateRules, PayeeRef, PoRef, RiskFlag } from '../extraction/rules';
import { FlaggedService } from '../flagged/flagged.service';
import { ContractRejectedError, NearService } from '../near/near.service';
import { NotifierService } from '../notify/notifier.service';
import { PrismaService } from '../prisma/prisma.service';
import { sha256Hex } from '../storage/storage.service';

/**
 * Judge mode: anyone can attack the live policy contract from the browser, without a wallet.
 *
 * Safety invariant: judge mode NEVER moves funds and never opens DAO proposals. A request_payment is only
 * submitted when the contract is certain to refuse it, i.e. the target account is not on the on-chain allowlist
 * or the invoice hash was already used. Both are checked against the contract right before submitting.
 * Attack runs are not stored as invoices; only the targeted addresses are remembered (flagged addresses).
 */

export type StepStatus = 'pass' | 'block' | 'skip' | 'info' | 'error';
export interface AttackStep {
  key: 'received' | 'extract' | 'rules' | 'agent' | 'contract' | 'flagged';
  title: string;
  status: StepStatus;
  detail: string;
  data?: Record<string, unknown>;
  txHash?: string;
  explorerUrl?: string;
}
export interface AttackRun {
  id: string;
  scenario: string;
  verdict: 'refused_on_chain' | 'blocked_offchain' | 'not_submitted';
  headline: string;
  steps: AttackStep[];
  at: string;
}

export const PRESETS = {
  'tampered-payee': {
    file: '02-tampered-payee.pdf',
    title: 'Swapped payout account',
    blurb: 'A real supplier invoice with the payment account changed to the attacker\'s. The classic business-email-compromise fraud.',
  },
  'prompt-injection': {
    file: '03-prompt-injection.pdf',
    title: 'Prompt injection',
    blurb: 'Hidden text tells the AI agent to "ignore previous instructions" and pay 50,000 USDC to the attacker.',
  },
  duplicate: {
    file: '01-normal.pdf',
    title: 'Pay the same invoice twice',
    blurb: 'Re-submits an invoice that was already paid on testnet. The contract remembers every paid PDF hash.',
  },
} as const;
export type PresetId = keyof typeof PRESETS;

const WINDOW_MS = 10 * 60_000;
const PER_IP = Number(process.env.ATTACK_PER_IP_PER_10MIN ?? 8);
const GLOBAL_PER_HOUR = Number(process.env.ATTACK_GLOBAL_PER_HOUR ?? 120);
/** Uploaded PDFs go through the real model; this caps NEAR AI spend (~$0.0003 each). */
const UPLOADS_PER_DAY = Number(process.env.ATTACK_UPLOADS_PER_DAY ?? 50);
const TELEGRAM_EVERY_MS = 2 * 60_000;

@Injectable()
export class AttackService {
  private readonly log = new Logger('Attack');
  private readonly extractionCache = new Map<string, ExtractionResult>();
  private readonly hits = new Map<string, number[]>();
  private global: number[] = [];
  private uploads = { day: '', count: 0 };
  private chainLock: Promise<unknown> = Promise.resolve();
  private lastTelegram = 0;
  private readonly recent: AttackRun[] = [];
  readonly stats = { runs: 0, refusedOnChain: 0 };

  constructor(
    private readonly prisma: PrismaService,
    private readonly extractor: ExtractorService,
    private readonly near: NearService,
    private readonly flagged: FlaggedService,
    private readonly notifier: NotifierService,
  ) {}

  info() {
    return {
      presets: Object.entries(PRESETS).map(([id, p]) => ({ id, title: p.title, blurb: p.blurb })),
      contract: config.near.policyContractId,
      agent: config.near.agentAccountId,
      network: this.near.simulated ? 'simulated' : config.near.networkId,
      extractor: mocks.extractor ? 'mock' : config.nearAi.model,
      limits: { perIpPer10Min: PER_IP, uploadsLeftToday: Math.max(0, UPLOADS_PER_DAY - this.uploadsToday()) },
      stats: this.stats,
      recent: this.recent.slice(0, 10),
    };
  }

  // ------------------------------------------------------------------ entry points

  async runPreset(id: string, ip: string): Promise<AttackRun> {
    const preset = PRESETS[id as PresetId];
    if (!preset) throw new BadRequestException(`Unknown scenario "${id}". Try: ${Object.keys(PRESETS).join(', ')}`);
    this.rateLimit(ip);
    const bytes = new Uint8Array(readFileSync(join(__dirname, '..', '..', 'fixtures', preset.file)));
    return this.runPdf(id, bytes, preset.file);
  }

  async runUpload(bytes: Uint8Array, fileName: string, ip: string): Promise<AttackRun> {
    if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new BadRequestException('file must be a PDF');
    this.rateLimit(ip);
    const hash = sha256Hex(bytes);
    if (!this.extractionCache.has(hash)) {
      if (this.uploadsToday() >= UPLOADS_PER_DAY) {
        throw new HttpException('Daily limit for uploaded invoices reached; try a preset attack', HttpStatus.TOO_MANY_REQUESTS);
      }
      this.uploads.count++;
    }
    return this.runPdf('upload', bytes, fileName);
  }

  /** "Rogue agent": skip the AI and the rules entirely and ask the contract to pay any account. */
  async runDirect(account: string, amount: string, ip: string): Promise<AttackRun> {
    this.rateLimit(ip);
    const steps: AttackStep[] = [
      {
        key: 'agent',
        title: 'Rogue agent',
        status: 'info',
        detail: `The agent's own key signs request_payment(${formatUsdc(amount)} USDC → ${account}). No invoice, no AI, no rule checks.`,
        data: { account, amount },
      },
    ];
    const contract = await this.submitIfRefusable({ account, amount, hash: randomBytes(32).toString('hex') });
    steps.push(contract.step);
    if (contract.refused) steps.push(await this.flag(account, 'DIRECT_ATTACK', amount));
    return this.finish('rogue-agent', steps, contract.refused ? 'refused_on_chain' : 'not_submitted', contract.refused
      ? `Refused on-chain: ${contract.reason}`
      : 'Not submitted: judge mode only sends payments the contract is certain to refuse');
  }

  // ------------------------------------------------------------------ pipeline

  private async runPdf(scenario: string, bytes: Uint8Array, fileName: string): Promise<AttackRun> {
    const hash = sha256Hex(bytes);
    const steps: AttackStep[] = [
      { key: 'received', title: 'Invoice received', status: 'pass', detail: `${fileName} · ${bytes.length.toLocaleString('en-US')} bytes`, data: { sha256: hash } },
    ];

    let result = this.extractionCache.get(hash);
    try {
      result ??= await this.extractor.extract(bytes);
      this.extractionCache.set(hash, result);
    } catch (e) {
      steps.push({ key: 'extract', title: 'AI extraction', status: 'error', detail: (e as Error).message });
      return this.finish(scenario, steps, 'blocked_offchain', 'The invoice could not be read');
    }
    const x = result.extracted;
    steps.push({
      key: 'extract',
      title: result.source === 'near-ai' ? `AI extraction · NEAR AI Cloud (${result.model})` : 'Extraction (offline parser)',
      status: 'pass',
      detail: `${x.invoiceNumber} from ${x.payeeName}: ${formatUsdc(x.amount)} ${x.currency}, pay to ${x.payeeNearAccount ?? 'not stated'}`,
      data: { ...x },
    });

    const companyId = config.companyId;
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const [payees, pos, dupHash] = await Promise.all([
      this.prisma.payee.findMany({ where: { companyId } }),
      this.prisma.purchaseOrder.findMany({ where: { companyId } }),
      this.prisma.invoice.findMany({ where: { companyId, pdfHash: hash }, select: { id: true } }),
    ]);
    const rules = evaluateRules({
      extracted: x,
      rawText: result.text,
      payees: payees as PayeeRef[],
      purchaseOrders: pos as PoRef[],
      autoPayLimit: company.autoPayLimit,
      // The demo fixtures also exist as dashboard invoices; only the duplicate scenario should trip on that.
      duplicateHashInvoiceIds: scenario === 'duplicate' || scenario === 'upload' ? dupHash.map((d) => d.id) : [],
      duplicateNumberInvoiceIds: [],
    });
    const blocking = rules.flags.filter((f) => f.severity === 'block');
    steps.push({
      key: 'rules',
      title: 'Rule checks',
      status: rules.status === 'blocked' ? 'block' : 'pass',
      detail: blocking.length ? blocking.map((f) => f.message).join(' · ') : `No blocking issues (${rules.status.replace('_', ' ')})`,
      data: { status: rules.status, flags: rules.flags.map(({ code, severity, message }) => ({ code, severity, message })) },
    });

    // Now assume the worst: the agent is compromised and obeys the invoice instead of the rules.
    const target = this.attackerTarget(rules.flags, x.payeeNearAccount, rules.payee?.nearAccountId, x.amount);
    steps.push({
      key: 'agent',
      title: 'Compromised agent ignores the rules',
      status: 'info',
      detail: `Signs request_payment(${formatUsdc(target.amount)} USDC → ${target.account}) with the agent's real key.`,
      data: target,
    });

    const contract = await this.submitIfRefusable({ account: target.account, amount: target.amount, hash });
    steps.push(contract.step);

    const flaggedTargets = FlaggedService.targetsFromFlags(rules.flags, x.amount);
    for (const t of flaggedTargets) steps.push(await this.flag(t.account, t.reason, t.amount ?? x.amount));

    if (contract.refused) {
      return this.finish(scenario, steps, 'refused_on_chain', `Refused on-chain: ${contract.reason}`);
    }
    return this.finish(
      scenario,
      steps,
      rules.status === 'blocked' ? 'blocked_offchain' : 'not_submitted',
      rules.status === 'blocked' ? 'Blocked by the rule checks' : 'Looks legitimate: judge mode does not pay real suppliers',
    );
  }

  /** What a compromised agent would pay: the injected target, else the account printed on the invoice. */
  private attackerTarget(flags: RiskFlag[], printed: string | null | undefined, allowlisted: string | undefined, amount: string) {
    const inj = flags.find((f) => f.code === 'PROMPT_INJECTION')?.data?.target as { account?: string; amount?: string } | undefined;
    if (inj?.account) return { account: inj.account, amount: inj.amount ?? amount, why: 'injected instruction' };
    if (printed) return { account: printed.toLowerCase(), amount, why: 'account printed on the invoice' };
    return { account: allowlisted ?? 'unknown.testnet', amount, why: 'allowlisted payee' };
  }

  /**
   * Submits request_payment only when the contract will refuse it. Checks the chain first:
   * a non-allowlisted payee or an already-used hash both panic before any transfer or proposal.
   */
  private async submitIfRefusable(t: { account: string; amount: string; hash: string }): Promise<{ step: AttackStep; refused: boolean; reason?: string }> {
    const title = `Policy contract · ${config.near.policyContractId}`;
    const [payee, hashUsed] = await Promise.all([
      this.near.isAllowlistedStrict(t.account).catch(() => undefined),
      this.near.isHashUsed(t.hash),
    ]);
    if (payee === undefined || hashUsed === null) {
      return { refused: false, step: { key: 'contract', title, status: 'error', detail: 'Could not read the contract state; nothing was submitted.' } };
    }
    if (payee && !hashUsed) {
      return {
        refused: false,
        step: {
          key: 'contract',
          title,
          status: 'skip',
          detail: `${t.account} is an allowlisted supplier, so this payment could really go through. Judge mode never moves funds, so it was not submitted.`,
        },
      };
    }
    const invoiceId = `attack-${randomBytes(6).toString('hex')}`;
    const run = async () => {
      try {
        const r = await this.near.requestPayment({ invoice_id: invoiceId, payee: t.account, amount: t.amount, invoice_hash: t.hash, due_date: new Date().toISOString().slice(0, 10) });
        // Unreachable by construction; reported honestly if it ever happens.
        this.log.error(`attack ${invoiceId} was NOT refused: ${r.status} ${r.txHash}`);
        return { refused: false, step: { key: 'contract' as const, title, status: 'error' as const, detail: `Contract returned ${r.status}`, txHash: r.txHash, explorerUrl: this.near.explorerTxUrl(r.txHash) } };
      } catch (e) {
        if (!(e instanceof ContractRejectedError)) {
          return { refused: false, step: { key: 'contract' as const, title, status: 'error' as const, detail: `Network error: ${(e as Error).message}` } };
        }
        const reason = e.message.replace(/^Smart contract panicked: /, '');
        return {
          refused: true,
          reason,
          step: {
            key: 'contract' as const,
            title,
            status: 'block' as const,
            detail: `Transaction failed with "${reason}". No USDC moved.`,
            data: { invoiceId },
            txHash: e.txHash,
            explorerUrl: e.txHash && !this.near.simulated ? this.near.explorerTxUrl(e.txHash) : undefined,
          },
        };
      }
    };
    // One agent key, one nonce sequence: serialize submissions.
    const p = this.chainLock.then(run, run);
    this.chainLock = p.catch(() => undefined);
    return p;
  }

  private async flag(account: string, reason: string, amount?: string | null): Promise<AttackStep> {
    const before = await this.flagged.find(config.companyId, account);
    const row = await this.flagged.record(config.companyId, { account, reason, source: 'attack', amount });
    return {
      key: 'flagged',
      title: 'Address flagged',
      status: 'info',
      detail: before
        ? `${account} was already on the flagged list (${row?.hits ?? before.hits + 1} attempts). Registering it as a payee now needs an explicit override.`
        : `${account} is now on the flagged list. Registering it as a payee needs an explicit override.`,
      data: { account, hits: row?.hits },
    };
  }

  private finish(scenario: string, steps: AttackStep[], verdict: AttackRun['verdict'], headline: string): AttackRun {
    const run: AttackRun = { id: randomBytes(5).toString('hex'), scenario, verdict, headline, steps, at: new Date().toISOString() };
    this.stats.runs++;
    if (verdict === 'refused_on_chain') this.stats.refusedOnChain++;
    this.recent.unshift(run);
    this.recent.length = Math.min(this.recent.length, 20);
    if (verdict === 'refused_on_chain') void this.alert(run);
    return run;
  }

  private async alert(run: AttackRun) {
    if (Date.now() - this.lastTelegram < TELEGRAM_EVERY_MS) return;
    this.lastTelegram = Date.now();
    const company = await this.prisma.company.findUnique({ where: { id: config.companyId } });
    const contract = run.steps.find((s) => s.key === 'contract');
    const agent = run.steps.find((s) => s.key === 'agent');
    await this.notifier.sendTelegramText(
      company?.telegramChatId,
      '🛡 Attack refused on-chain (judge mode)',
      `${agent?.detail ?? ''}\n${run.headline}`,
      contract?.explorerUrl,
    );
  }

  // ------------------------------------------------------------------ limits

  private uploadsToday() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.uploads.day !== day) this.uploads = { day, count: 0 };
    return this.uploads.count;
  }

  private rateLimit(ip: string) {
    const now = Date.now();
    this.global = this.global.filter((t) => now - t < 3_600_000);
    if (this.global.length >= GLOBAL_PER_HOUR) throw new HttpException('Judge mode is busy; try again in a few minutes', HttpStatus.TOO_MANY_REQUESTS);
    const mine = (this.hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (mine.length >= PER_IP) throw new HttpException(`Slow down: ${PER_IP} attacks per 10 minutes per visitor`, HttpStatus.TOO_MANY_REQUESTS);
    mine.push(now);
    this.hits.set(ip, mine);
    this.global.push(now);
  }
}
