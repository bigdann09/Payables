export const EVENT_STANDARD = 'payables';
export const EVENT_VERSION = '1.0.0';

export type PayablesEventName =
  | 'payment_requested'
  | 'payment_escalated'
  | 'payment_paid'
  | 'payment_failed'
  | 'payment_rejected'
  | 'payee_registered'
  | 'payee_change_requested'
  | 'payee_changed'
  | 'limits_updated';

export interface PayablesEvent {
  standard: string;
  version: string;
  event: PayablesEventName | string;
  data: Record<string, unknown>[];
}

export function formatEvent(event: PayablesEventName, data: Record<string, unknown>): string {
  return `EVENT_JSON:${JSON.stringify({ standard: EVENT_STANDARD, version: EVENT_VERSION, event, data: [data] })}`;
}

/** Parse NEP-297 `EVENT_JSON:` logs, keeping only the `payables` standard. Non-JSON / foreign logs are ignored. */
export function parseEvents(logs: string[]): PayablesEvent[] {
  const out: PayablesEvent[] = [];
  for (const log of logs) {
    if (!log.startsWith('EVENT_JSON:')) continue;
    try {
      const ev = JSON.parse(log.slice('EVENT_JSON:'.length));
      if (ev?.standard !== EVENT_STANDARD) continue;
      out.push({ ...ev, data: Array.isArray(ev.data) ? ev.data : ev.data ? [ev.data] : [] });
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

/** Collect logs from a FinalExecutionOutcome-like object (transaction + all receipts). */
export function logsFromOutcome(outcome: {
  transaction_outcome?: { outcome?: { logs?: string[] } };
  receipts_outcome?: { outcome?: { logs?: string[] } }[];
}): string[] {
  return [
    ...(outcome.transaction_outcome?.outcome?.logs ?? []),
    ...(outcome.receipts_outcome ?? []).flatMap((r) => r.outcome?.logs ?? []),
  ];
}

export type PaymentOutcomeStatus = 'paid' | 'pending_approval' | 'failed' | 'rejected' | 'paying';

/** Derive the resulting invoice status (and DAO proposal id) from emitted events. Last terminal event wins. */
export function outcomeFromEvents(events: PayablesEvent[], invoiceId: string): { status: PaymentOutcomeStatus; proposalId?: string } {
  let status: PaymentOutcomeStatus = 'paying';
  let proposalId: string | undefined;
  for (const ev of events) {
    const d = ev.data.find((x) => x.invoice_id === undefined || x.invoice_id === invoiceId) ?? {};
    switch (ev.event) {
      case 'payment_escalated':
        status = 'pending_approval';
        if (d.proposal_id !== undefined) proposalId = String(d.proposal_id);
        break;
      case 'payment_paid':
        status = 'paid';
        break;
      case 'payment_failed':
        status = 'failed';
        break;
      case 'payment_rejected':
        status = 'rejected';
        break;
    }
  }
  return { status, proposalId };
}
