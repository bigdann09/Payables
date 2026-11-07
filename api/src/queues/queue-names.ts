export const EXTRACT_QUEUE = 'extract';
export const PAY_QUEUE = 'pay';
export const NOTIFY_QUEUE = 'notify';

export interface ExtractJob {
  invoiceId: string;
  declaredPayeeId?: string;
}

export interface PayJob {
  invoiceId: string;
  /** Demo only: submit what the invoice/injection asks for, to show the contract refusing it. */
  force?: boolean;
  trigger: 'due_date' | 'pay_now';
}

export type NotifyType = 'approval_needed' | 'paid' | 'blocked' | 'failed';

export interface NotifyJob {
  type: NotifyType;
  invoiceId: string;
}
