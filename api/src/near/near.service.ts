import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Account } from '@near-js/accounts';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { actionCreators } from '@near-js/transactions';
import type { KeyPairString } from '@near-js/crypto';
import { config, mocks } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { logsFromOutcome, outcomeFromEvents, parseEvents, PayablesEvent, PaymentOutcomeStatus } from './events';
import { ContractPanic, PolicySimulator, RequestPaymentArgs, SimTxResult } from './policy-sim';

const TGAS = 1_000_000_000_000n;

/** A deterministic, non-retryable refusal by the policy contract (panic / failed tx). */
export class ContractRejectedError extends Error {
  constructor(
    message: string,
    readonly txHash?: string,
  ) {
    super(message);
    this.name = 'ContractRejectedError';
  }
}

export interface ChainTx {
  txHash: string;
  logs: string[];
  events: PayablesEvent[];
  simulated: boolean;
}

export interface PaymentResult extends ChainTx {
  status: PaymentOutcomeStatus;
  proposalId?: string;
}

export interface ChainInvoice {
  invoice_id: string;
  payee: string;
  amount: string;
  status: 'pending_approval' | 'paying' | 'paid' | 'failed' | 'rejected';
  proposal_id?: number | string | null;
}

/**
 * Client for the policy contract. Uses real NEAR RPC + keys when AGENT_PRIVATE_KEY is set,
 * otherwise a PolicySimulator that applies the contract's rules in memory (hydrated from the DB on boot).
 */
@Injectable()
export class NearService implements OnModuleInit {
  private readonly log = new Logger('Near');
  readonly simulated = mocks.chain;
  private provider?: JsonRpcProvider;
  private agent?: Account;
  private owner?: Account;
  sim?: PolicySimulator;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    if (this.simulated) {
      this.log.warn('[MOCK] AGENT_PRIVATE_KEY not set; using simulated policy contract (same rules, in memory, hydrated from DB)');
      await this.hydrateSimulator();
      return;
    }
    this.provider = new JsonRpcProvider({ url: config.near.rpcUrl });
    this.agent = new Account(config.near.agentAccountId, this.provider, KeyPairSigner.fromSecretKey(config.near.agentPrivateKey as KeyPairString));
    if (config.near.ownerPrivateKey && config.near.ownerAccountId) {
      this.owner = new Account(config.near.ownerAccountId, this.provider, KeyPairSigner.fromSecretKey(config.near.ownerPrivateKey as KeyPairString));
    } else {
      this.log.warn('OWNER_ACCOUNT_ID/OWNER_PRIVATE_KEY not set; owner calls (register_payee, set_limits, request_payee_change) will fail');
    }
    this.log.log(`Using NEAR ${config.near.networkId} rpc=${config.near.rpcUrl} contract=${config.near.policyContractId} agent=${config.near.agentAccountId}`);
  }

  // ------------------------------------------------------------------ change methods

  async requestPayment(args: RequestPaymentArgs): Promise<PaymentResult> {
    const tx = await this.call('agent', 'request_payment', args as unknown as Record<string, unknown>, 300n * TGAS, (sim) =>
      sim.requestPayment(config.near.agentAccountId, args),
    );
    return { ...tx, ...outcomeFromEvents(tx.events, args.invoice_id) };
  }

  async registerPayee(accountId: string, name: string): Promise<ChainTx> {
    return this.call('owner', 'register_payee', { account_id: accountId, name }, 100n * TGAS, (sim) =>
      sim.registerPayee(sim.config.owner_id, accountId, name),
    );
  }

  async requestPayeeChange(oldId: string, newId: string): Promise<ChainTx & { proposalId?: string }> {
    let proposalId: string | undefined;
    const tx = await this.call('owner', 'request_payee_change', { old: oldId, new: newId }, 200n * TGAS, (sim) => {
      const r = sim.requestPayeeChange(sim.config.owner_id, oldId, newId);
      proposalId = String(r.value);
      return r;
    });
    if (proposalId === undefined) {
      const ev = tx.events.find((e) => e.event === 'payee_change_requested');
      const id = ev?.data[0]?.proposal_id;
      if (id !== undefined) proposalId = String(id);
    }
    return { ...tx, proposalId };
  }

  async setLimits(autoPayLimit: string, dailyCap: string): Promise<ChainTx> {
    return this.call('owner', 'set_limits', { auto_pay_limit: autoPayLimit, daily_cap: dailyCap }, 30n * TGAS, (sim) =>
      sim.setLimits(sim.config.owner_id, autoPayLimit, dailyCap),
    );
  }

  /** Owner-side rejection. Sputnik never calls back on a "no" vote, so the API mirrors it on-chain. */
  async rejectPayment(invoiceId: string): Promise<ChainTx> {
    return this.call('owner', 'reject_payment', { invoice_id: invoiceId }, 30n * TGAS, (sim) =>
      sim.rejectPayment(sim.config.owner_id, invoiceId),
    );
  }

  /** Real chain only; the simulator's dev DAO routes have no payee-change rejection. */
  async rejectPayeeChange(oldId: string): Promise<ChainTx> {
    return this.call('owner', 'reject_payee_change', { old: oldId }, 30n * TGAS, () => {
      throw new Error('reject_payee_change is not simulated');
    });
  }

  /** Sputnik proposal status: InProgress | Approved | Rejected | Removed | Expired | Moved | Failed. */
  async getDaoProposalStatus(proposalId: string): Promise<string | null> {
    if (this.sim) return null;
    const p = await this.viewOn<{ status: string }>(config.near.daoId, 'get_proposal', { id: Number(proposalId) });
    return p?.status ?? null;
  }

  /** Simulator-only: act as the DAO after a successful vote. */
  simDaoRelease(invoiceId: string): PaymentResult {
    const sim = this.requireSim();
    const r = this.runSim(() => sim.releasePayment(sim.config.dao_id, invoiceId));
    return { ...r, ...outcomeFromEvents(r.events, invoiceId) };
  }

  simDaoReject(invoiceId: string): PaymentResult {
    const sim = this.requireSim();
    const r = this.runSim(() => sim.rejectPayment(sim.config.dao_id, invoiceId));
    return { ...r, ...outcomeFromEvents(r.events, invoiceId) };
  }

  simDaoApprovePayeeChange(proposalId: number): ChainTx {
    const sim = this.requireSim();
    return this.runSim(() => sim.approvePayeeChange(sim.config.dao_id, proposalId));
  }

  // ------------------------------------------------------------------ views

  async getInvoice(invoiceId: string): Promise<ChainInvoice | null> {
    if (this.sim) return this.sim.getInvoice(invoiceId);
    return this.view<ChainInvoice | null>('get_invoice', { invoice_id: invoiceId });
  }

  async getPayee(accountId: string): Promise<unknown> {
    if (this.sim) return this.sim.getPayee(accountId);
    return this.view('get_payee', { account_id: accountId });
  }

  /** Allowlist check that THROWS on RPC errors instead of returning null (red-team safety gate). */
  async isAllowlistedStrict(accountId: string): Promise<boolean> {
    if (this.sim) return this.sim.getPayee(accountId) != null;
    const v = await this.provider!.callFunction(config.near.policyContractId, 'get_payee', { account_id: accountId });
    return v != null;
  }

  /** True once a payment with this PDF hash went through (or is pending) on the contract. */
  async isHashUsed(hash: string): Promise<boolean | null> {
    if (this.sim) return this.sim.paidHashes.has(hash.toLowerCase());
    return this.view<boolean>('is_hash_used', { invoice_hash: hash });
  }

  async getConfig(): Promise<Record<string, unknown> | null> {
    if (this.sim) return { ...this.sim.getConfig() };
    return this.cached('get_config', () => this.view('get_config', {}));
  }

  async getDailySpent(): Promise<string | null> {
    if (this.sim) return this.sim.getDailySpent();
    const v = await this.cached('get_daily_spent', () => this.view<string | number>('get_daily_spent', {}));
    return v == null ? null : String(v);
  }

  async getTreasuryBalance(): Promise<string | null> {
    if (this.sim) return this.sim.treasury.toString();
    const v = await this.cached('treasury', () =>
      this.viewOn<string>(config.near.usdcContractId, 'ft_balance_of', { account_id: config.near.policyContractId }),
    );
    return v == null ? null : String(v);
  }

  explorerTxUrl(txHash: string): string {
    return `${config.near.explorerTxUrl}${txHash}`;
  }

  daoProposalUrl(daoId: string, proposalId: string): string {
    return `${config.near.astroDaoUrl}/dao/${daoId}/proposals/${daoId}-${proposalId}`;
  }

  // ------------------------------------------------------------------ internals

  private async call(
    as: 'agent' | 'owner',
    method: string,
    args: Record<string, unknown>,
    gas: bigint,
    simulate: (sim: PolicySimulator) => SimTxResult<unknown>,
  ): Promise<ChainTx> {
    if (this.sim) return this.runSim(() => simulate(this.sim!));
    const account = as === 'agent' ? this.agent : this.owner;
    if (!account) throw new Error(`${as} key not configured (set ${as.toUpperCase()}_ACCOUNT_ID / ${as.toUpperCase()}_PRIVATE_KEY)`);
    const outcome = await account.signAndSendTransaction({
      receiverId: config.near.policyContractId,
      actions: [actionCreators.functionCall(method, args, gas, 0n)],
      waitUntil: 'FINAL',
      throwOnFailure: false,
    });
    const txHash = outcome.transaction_outcome.id;
    const logs = logsFromOutcome(outcome);
    const status = outcome.status as { Failure?: unknown };
    if (typeof status === 'object' && status && status.Failure) {
      throw new ContractRejectedError(describeFailure(status.Failure), txHash);
    }
    return { txHash, logs, events: parseEvents(logs), simulated: false };
  }

  private runSim<T>(fn: () => SimTxResult<T>): ChainTx & { value: T } {
    try {
      const r = fn();
      return { txHash: r.txHash, logs: r.logs, events: parseEvents(r.logs), simulated: true, value: r.value };
    } catch (e) {
      if (e instanceof ContractPanic) throw new ContractRejectedError(e.message);
      throw e;
    }
  }

  private requireSim(): PolicySimulator {
    if (!this.sim) throw new Error('Only available with the simulated chain; on testnet the DAO votes on AstroDAO');
    return this.sim;
  }

  /** Dashboard reads (config, daily spend, treasury) are polled by every open tab; a short TTL keeps RPC
   * latency off the UI. Failed (null) reads are not cached. Payment paths never go through this. */
  private readonly viewCache = new Map<string, { at: number; value: Promise<unknown> }>();
  private async cached<T>(key: string, load: () => Promise<T | null>, ttlMs = 5000): Promise<T | null> {
    const hit = this.viewCache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T | null>;
    const value = load();
    this.viewCache.set(key, { at: Date.now(), value });
    const v = await value;
    if (v == null) this.viewCache.delete(key);
    return v;
  }

  private async view<T>(method: string, args: Record<string, unknown>): Promise<T | null> {
    return this.viewOn<T>(config.near.policyContractId, method, args);
  }

  private async viewOn<T>(contractId: string, method: string, args: Record<string, unknown>): Promise<T | null> {
    try {
      return ((await this.provider!.callFunction(contractId, method, args)) ?? null) as T | null;
    } catch (e) {
      this.log.warn(`view ${contractId}.${method} failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Rebuild simulator state from the database so it survives restarts. */
  async hydrateSimulator() {
    const company = await this.prisma.company.findUnique({ where: { id: config.companyId } });
    const sim = new PolicySimulator(
      {
        owner_id: config.near.ownerAccountId ?? 'owner.payables.testnet',
        agent_id: config.near.agentAccountId,
        dao_id: company?.daoId ?? config.near.daoId,
        usdc_id: config.near.usdcContractId,
        auto_pay_limit: company?.autoPayLimit ?? '5000000000',
        daily_cap: company?.dailyCap ?? '20000000000',
      },
      BigInt(config.near.simTreasury),
    );
    if (company) {
      const payees = await this.prisma.payee.findMany({ where: { companyId: company.id } });
      for (const p of payees) sim.payees.set(p.nearAccountId, { name: p.name, registered_at: p.createdAt.getTime() });
      const onChain = await this.prisma.invoice.findMany({
        where: { companyId: company.id, txHash: { not: null }, status: { in: ['paying', 'paid', 'pending_approval', 'failed', 'rejected'] } },
        include: { payee: true },
      });
      const today = Math.floor(Date.now() / 86_400_000);
      let maxProposal = -1;
      for (const inv of onChain) {
        const status = inv.status as ChainInvoice['status'];
        const proposalId = inv.daoProposalId != null ? Number(inv.daoProposalId) : undefined;
        if (proposalId !== undefined && Number.isFinite(proposalId)) maxProposal = Math.max(maxProposal, proposalId);
        sim.invoices.set(inv.id, {
          invoice_id: inv.id,
          payee: inv.payee?.nearAccountId ?? '',
          amount: inv.amount ?? '0',
          invoice_hash: inv.pdfHash,
          due_date: inv.dueDate?.toISOString().slice(0, 10) ?? '',
          status,
          proposal_id: proposalId,
          created_at: inv.createdAt.getTime(),
        });
        if (status === 'paid' || status === 'pending_approval' || status === 'paying') sim.paidHashes.add(inv.pdfHash);
        if (status === 'paid' && inv.amount) {
          sim.treasury -= BigInt(inv.amount);
          if (inv.daoProposalId == null && inv.paidAt && Math.floor(inv.paidAt.getTime() / 86_400_000) === today) {
            sim.dailySpent = { day: today, amount: sim.dailySpent.amount + BigInt(inv.amount) };
          }
        }
      }
      (sim as unknown as { nextProposalId: number }).nextProposalId = maxProposal + 1;
    }
    this.sim = sim;
    this.log.log(`Simulator hydrated: ${sim.payees.size} payees, ${sim.invoices.size} invoices, treasury=${sim.treasury}`);
  }
}

function describeFailure(failure: unknown): string {
  const s = JSON.stringify(failure);
  const m = /"ExecutionError":"([^"]+)"/.exec(s) ?? /Smart contract panicked: ([^"\\]+)/.exec(s);
  return m ? m[1] : s;
}
