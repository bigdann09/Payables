import { z } from 'zod';
import { toBaseUnits } from '../common/amount';

const amountLike = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    return toBaseUnits(v);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: (e as Error).message });
    return z.NEVER;
  }
});

const optionalString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v == null || v.trim() === '' ? undefined : v.trim()));

/**
 * Model output → normalised extraction. Amounts in the model output are human decimals ("1,850.00");
 * after parsing they are USDC base-unit strings, matching the rest of the system.
 */
export const ExtractedInvoiceSchema = z.object({
  invoiceNumber: z.string().trim().min(1),
  payeeName: z.string().trim().min(1),
  payeeNearAccount: optionalString,
  amount: amountLike,
  currency: z.string().trim().toUpperCase().default('USDC'),
  dueDate: z
    .string()
    .trim()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date')
    .transform((s) => new Date(Date.parse(s)).toISOString().slice(0, 10)),
  poNumber: optionalString,
  lineItems: z
    .array(
      z.object({
        description: z.string().trim(),
        quantity: z.union([z.number(), z.string()]).optional().transform((v) => (v === undefined ? undefined : Number(v))),
        unitPrice: amountLike.optional(),
        amount: amountLike,
      }),
    )
    .default([]),
});

export type ExtractedInvoice = z.output<typeof ExtractedInvoiceSchema>;
