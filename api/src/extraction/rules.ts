import { formatUsdc } from '../common/amount';
import type { ExtractedInvoice } from './schema';
import { detectPromptInjection } from './injection';

export type RiskCode =
  | 'PAYEE_MISMATCH'
  | 'AMOUNT_EXCEEDS_PO'
  | 'NO_PO'
  | 'DUPLICATE_HASH'
  | 'DUPLICATE_NUMBER'
  | 'PROMPT_INJECTION'
  | 'OVER_LIMIT';

export type Severity = 'info' | 'warn' | 'block';

export interface RiskFlag {
  code: RiskCode;
  severity: Severity;
  message: string;
  /** Optional machine-readable details (additive to SPEC shape). */
  data?: Record<string, unknown>;
}

export interface PayeeRef {
  id: string;
  name: string;
  nearAccountId: string;
  status: 'active' | 'pending_change';
}

export interface PoRef {
  id: string;
  number: string;
  payeeId: string;
  amount: string;
  status: 'open' | 'closed';
}

export interface RuleInput {
  extracted: ExtractedInvoice;
  rawText: string;
  /** Allowlisted payees of the company. */
  payees: PayeeRef[];
  purchaseOrders: PoRef[];
  /** Payee chosen in the contractor portal upload, if any. */
  declaredPayeeId?: string;
  autoPayLimit: string;
  /** Other invoices of this company with the same PDF hash. */
  duplicateHashInvoiceIds: string[];
  /** Other invoices with the same number from the same payee. */
  duplicateNumberInvoiceIds: string[];
}

export interface RuleResult {
  flags: RiskFlag[];
  payee?: PayeeRef;
  po?: PoRef;
  status: 'scheduled' | 'needs_review' | 'blocked';
}

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(inc|llc|ltd|gmbh|corp|co|company|limited|sa|bv|oy|ag)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchPayeeByName(name: string, payees: PayeeRef[]): PayeeRef | undefined {
  const n = normalizeName(name);
  if (!n) return undefined;
  const exact = payees.filter((p) => normalizeName(p.name) === n);
  if (exact.length === 1) return exact[0];
  const partial = payees.filter((p) => {
    const pn = normalizeName(p.name);
    return pn.length >= 4 && (n.includes(pn) || pn.includes(n));
  });
  return partial.length === 1 ? partial[0] : undefined;
}

/**
 * Deterministic risk rules. The model's output is treated as untrusted data: the payee is resolved
 * from the allowlist (declared payee → PO → name), never from an account written on the invoice.
 */
export function evaluateRules(input: RuleInput): RuleResult {
  const { extracted, payees } = input;
  const flags: RiskFlag[] = [];

  // --- Purchase order
  const po = extracted.poNumber
    ? input.purchaseOrders.find((p) => p.number.toLowerCase() === extracted.poNumber!.toLowerCase())
    : undefined;

  // --- Payee resolution (allowlist only)
  const declared = input.declaredPayeeId ? payees.find((p) => p.id === input.declaredPayeeId) : undefined;
  const byPo = po ? payees.find((p) => p.id === po.payeeId) : undefined;
  const byName = matchPayeeByName(extracted.payeeName, payees);
  const payee = declared ?? byPo ?? byName;

  if (!payee) {
    flags.push({
      code: 'PAYEE_MISMATCH',
      severity: 'block',
      message: `Payee "${extracted.payeeName}" does not match any allowlisted payee`,
      data: { claimedAccount: extracted.payeeNearAccount },
    });
  } else {
    const conflicts = [declared, byPo, byName].filter((p): p is PayeeRef => !!p && p.id !== payee.id);
    if (conflicts.length) {
      flags.push({
        code: 'PAYEE_MISMATCH',
        severity: 'block',
        message: `Payee resolution is ambiguous: ${[payee, ...conflicts].map((p) => p.name).join(' vs ')}`,
      });
    }
    if (extracted.payeeNearAccount && extracted.payeeNearAccount.toLowerCase() !== payee.nearAccountId.toLowerCase()) {
      flags.push({
        code: 'PAYEE_MISMATCH',
        severity: 'block',
        message: `Invoice asks for payment to ${extracted.payeeNearAccount}, but ${payee.name}'s allowlisted account is ${payee.nearAccountId}`,
        data: { claimedAccount: extracted.payeeNearAccount, allowlistedAccount: payee.nearAccountId },
      });
    }
    if (payee.status === 'pending_change') {
      flags.push({
        code: 'PAYEE_MISMATCH',
        severity: 'warn',
        message: `${payee.name} has a payee account change awaiting DAO approval`,
      });
    }
  }

  // --- PO checks
  if (!extracted.poNumber) {
    flags.push({ code: 'NO_PO', severity: 'warn', message: 'Invoice does not reference a purchase order' });
  } else if (!po) {
    flags.push({ code: 'NO_PO', severity: 'warn', message: `Purchase order ${extracted.poNumber} not found` });
  } else {
    if (po.status === 'closed') {
      flags.push({ code: 'NO_PO', severity: 'warn', message: `Purchase order ${po.number} is closed` });
    }
    if (BigInt(extracted.amount) > BigInt(po.amount)) {
      flags.push({
        code: 'AMOUNT_EXCEEDS_PO',
        severity: 'warn',
        message: `Amount ${formatUsdc(extracted.amount)} USDC exceeds ${po.number} (${formatUsdc(po.amount)} USDC)`,
      });
    }
  }

  // --- Duplicates
  if (input.duplicateHashInvoiceIds.length) {
    flags.push({
      code: 'DUPLICATE_HASH',
      severity: 'block',
      message: 'An identical PDF was already submitted',
      data: { invoiceIds: input.duplicateHashInvoiceIds },
    });
  }
  if (input.duplicateNumberInvoiceIds.length) {
    flags.push({
      code: 'DUPLICATE_NUMBER',
      severity: 'block',
      message: `Invoice number ${extracted.invoiceNumber} was already submitted by this payee`,
      data: { invoiceIds: input.duplicateNumberInvoiceIds },
    });
  }

  // --- Prompt injection (raw text is data only)
  const inj = detectPromptInjection(input.rawText);
  if (inj.detected) {
    flags.push({
      code: 'PROMPT_INJECTION',
      severity: 'block',
      message: `Instruction-like text found in invoice: "${inj.matches[0].excerpt}"`,
      data: { matches: inj.matches, target: inj.target },
    });
  }

  // --- Limit (informational: the contract escalates to the DAO)
  if (BigInt(extracted.amount) > BigInt(input.autoPayLimit)) {
    flags.push({
      code: 'OVER_LIMIT',
      severity: 'info',
      message: `Amount ${formatUsdc(extracted.amount)} USDC is above the auto-pay limit (${formatUsdc(input.autoPayLimit)} USDC); DAO approval required`,
    });
  }

  const status = flags.some((f) => f.severity === 'block')
    ? 'blocked'
    : flags.some((f) => f.severity === 'warn')
      ? 'needs_review'
      : 'scheduled';

  return { flags, payee, po, status };
}
