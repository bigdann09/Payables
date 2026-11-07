import { createHash } from 'node:crypto';
import { baseEncode } from '@near-js/utils';
import { formatEvent } from './events';

/**
 * In-memory simulation of the `payables` policy contract (see SPEC.md "Policy contract interface").
 * Applies the same rules as the contract: agent-only request_payment, allowlist, duplicate hash,
 * duplicate invoice id, auto-pay limit, daily cap (UTC day) and escalation to a DAO proposal.
 * Errors mirror contract panics: they throw `ContractPanic` and leave state untouched.
 */

export class ContractPanic extends Error {
  constructor(message: string) {
    super(`Smart contract panicked: ${message}`);
    this.name = 'ContractPanic';
  }
}

export type SimInvoiceStatus = 'pending_approval' | 'paying' | 'paid' | 'failed' | 'rejected';

export interface SimInvoice {
  invoice_id: string;
  payee: string;
  amount: string;
  invoice_hash: string;
  due_date: string;
  status: SimInvoiceStatus;
  proposal_id?: number;
  created_at: number;
}

export interface SimConfig {
  owner_id: string;
  agent_id: string;
  dao_id: string;
  usdc_id: string;
  auto_pay_limit: string;
  daily_cap: string;
}

export interface SimTxResult<T = unknown> {
  txHash: string;
  logs: string[];
  value: T;
}

export interface RequestPaymentArgs {
  invoice_id: string;
  payee: string;
  amount: string;
  invoice_hash: string;
  due_date: string;
}

const DAY_MS = 86_400_000;

export class PolicySimulator {
  config: SimConfig;
  payees = new Map<string, { name: string; registered_at: number }>();
  pendingPayeeChanges = new Map<number, { old: string; new: string }>();
  invoices = new Map<string, SimInvoice>();
  paidHashes = new Set<string>();
  treasury: bigint;
  dailySpent = { day: -1, amount: 0n };
  private nextProposalId = 0;
  private nonce = 0;

  constructor(cfg: SimConfig, treasury: bigint, private readonly now: () => number = Date.now) {
    this.config = { ...cfg };
    this.treasury = treasury;
  }

  // ---------- helpers ----------
  private txHash(seed: string): string {
    return baseEncode(createHash('sha256').update(`${seed}:${++this.nonce}:${this.now()}`).digest());
  }

  private today(): number {
    return Math.floor(this.now() / DAY_MS);
  }

  private spentToday(): bigint {
    return this.dailySpent.day === this.today() ? this.dailySpent.amount : 0n;
  }

  private assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new ContractPanic(msg);
  }

  /** Simulated ft_transfer + callback. Returns logs for the outcome. */
  private transfer(inv: SimInvoice, countTowardsDailyCap: boolean): string[] {
    const amount = BigInt(inv.amount);
    if (this.treasury < amount) {
      inv.status = 'failed';
      this.paidHashes.delete(inv.invoice_hash);
      return [formatEvent('payment_failed', { invoice_id: inv.invoice_id, reason: 'ft_transfer failed: insufficient balance' })];
    }
    this.treasury -= amount;
    if (countTowardsDailyCap) {
      this.dailySpent = { day: this.today(), amount: this.spentToday() + amount };
    }
    inv.status = 'paid';
    return [formatEvent('payment_paid', { invoice_id: inv.invoice_id, payee: inv.payee, amount: inv.amount })];
  }

  // ---------- change methods ----------
  requestPayment(caller: string, args: RequestPaymentArgs): SimTxResult<SimInvoice> {
    this.assert(caller === this.config.agent_id, 'Only the agent can request payments');
    this.assert(/^\d+$/.test(args.amount) && BigInt(args.amount) > 0n, 'Invalid amount');
    this.assert(this.payees.has(args.payee), `Payee ${args.payee} is not allowlisted`);
    this.assert(!this.paidHashes.has(args.invoice_hash), 'Invoice hash already paid');
    const existing = this.invoices.get(args.invoice_id);
    this.assert(!existing || existing.status === 'failed', `Invoice ${args.invoice_id} already exists`);

    const amount = BigInt(args.amount);
    const withinLimit = amount <= BigInt(this.config.auto_pay_limit);
    const withinCap = this.spentToday() + amount <= BigInt(this.config.daily_cap);
    const inv: SimInvoice = { ...args, status: 'paying', created_at: this.now() };
    this.invoices.set(inv.invoice_id, inv);
    this.paidHashes.add(inv.invoice_hash);

    const logs = [
      formatEvent('payment_requested', {
        invoice_id: inv.invoice_id,
        payee: inv.payee,
        amount: inv.amount,
        invoice_hash: inv.invoice_hash,
        auto_pay: withinLimit && withinCap,
      }),
    ];

    if (withinLimit && withinCap) {
      logs.push(...this.transfer(inv, true));
    } else {
      const proposalId = this.nextProposalId++;
      inv.status = 'pending_approval';
      inv.proposal_id = proposalId;
      logs.push(
        formatEvent('payment_escalated', {
          invoice_id: inv.invoice_id,
          proposal_id: proposalId,
          dao_id: this.config.dao_id,
          payee: inv.payee,
          amount: inv.amount,
          reason: withinLimit ? 'daily_cap_exceeded' : 'over_auto_pay_limit',
        }),
      );
    }
    return { txHash: this.txHash(`request_payment:${inv.invoice_id}`), logs, value: { ...inv } };
  }

  releasePayment(caller: string, invoiceId: string): SimTxResult<SimInvoice> {
    this.assert(caller === this.config.dao_id, 'Only the DAO can release payments');
    const inv = this.invoices.get(invoiceId);
    this.assert(inv, 'Invoice not found');
    this.assert(inv.status === 'pending_approval', 'Invoice is not pending approval');
    const logs = this.transfer(inv, false);
    return { txHash: this.txHash(`release_payment:${invoiceId}`), logs, value: { ...inv } };
  }

  rejectPayment(caller: string, invoiceId: string): SimTxResult<SimInvoice> {
    this.assert(caller === this.config.dao_id || caller === this.config.owner_id, 'Only the DAO or owner can reject');
    const inv = this.invoices.get(invoiceId);
    this.assert(inv, 'Invoice not found');
    this.assert(inv.status === 'pending_approval', 'Invoice is not pending approval');
    inv.status = 'rejected';
    this.paidHashes.delete(inv.invoice_hash);
    return {
      txHash: this.txHash(`reject_payment:${invoiceId}`),
      logs: [formatEvent('payment_rejected', { invoice_id: invoiceId })],
      value: { ...inv },
    };
  }

  registerPayee(caller: string, accountId: string, name: string): SimTxResult<null> {
    this.assert(caller === this.config.owner_id, 'Only the owner can register payees');
    this.assert(!this.payees.has(accountId), `Payee ${accountId} already registered`);
    this.payees.set(accountId, { name, registered_at: this.now() });
    return {
      txHash: this.txHash(`register_payee:${accountId}`),
      logs: [formatEvent('payee_registered', { account_id: accountId, name })],
      value: null,
    };
  }

  requestPayeeChange(caller: string, oldId: string, newId: string): SimTxResult<number> {
    this.assert(caller === this.config.owner_id, 'Only the owner can request payee changes');
    this.assert(this.payees.has(oldId), `Payee ${oldId} is not registered`);
    this.assert(!this.payees.has(newId), `Payee ${newId} already registered`);
    const proposalId = this.nextProposalId++;
    this.pendingPayeeChanges.set(proposalId, { old: oldId, new: newId });
    return {
      txHash: this.txHash(`request_payee_change:${oldId}`),
      logs: [formatEvent('payee_change_requested', { old: oldId, new: newId, proposal_id: proposalId })],
      value: proposalId,
    };
  }

  approvePayeeChange(caller: string, proposalId: number): SimTxResult<null> {
    this.assert(caller === this.config.dao_id, 'Only the DAO can approve payee changes');
    const change = this.pendingPayeeChanges.get(proposalId);
    this.assert(change, 'Payee change not found');
    const payee = this.payees.get(change.old)!;
    this.payees.delete(change.old);
    this.payees.set(change.new, { name: payee.name, registered_at: this.now() });
    this.pendingPayeeChanges.delete(proposalId);
    return {
      txHash: this.txHash(`approve_payee_change:${proposalId}`),
      logs: [formatEvent('payee_changed', { old: change.old, new: change.new })],
      value: null,
    };
  }

  setLimits(caller: string, autoPayLimit: string, dailyCap: string): SimTxResult<null> {
    this.assert(caller === this.config.owner_id, 'Only the owner can set limits');
    this.assert(/^\d+$/.test(autoPayLimit) && /^\d+$/.test(dailyCap), 'Invalid limits');
    this.config.auto_pay_limit = autoPayLimit;
    this.config.daily_cap = dailyCap;
    return { txHash: this.txHash('set_limits'), logs: [], value: null };
  }

  // ---------- views ----------
  getInvoice(invoiceId: string): SimInvoice | null {
    const inv = this.invoices.get(invoiceId);
    return inv ? { ...inv } : null;
  }

  getPayee(accountId: string) {
    const p = this.payees.get(accountId);
    return p ? { ...p } : null;
  }

  getConfig(): SimConfig {
    return { ...this.config };
  }

  getDailySpent(): string {
    return this.spentToday().toString();
  }
}
