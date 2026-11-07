import { BadRequestException, PipeTransform } from '@nestjs/common';
import { z } from 'zod';

export class ZodPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.output<T> {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) {
      throw new BadRequestException(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`));
    }
    return r.data;
  }
}

export const baseUnits = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^\d+$/.test(v), 'must be an integer string in USDC base units (6 decimals)');

export const nearAccountId = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, 'invalid NEAR account id')
  .min(2)
  .max(64);
