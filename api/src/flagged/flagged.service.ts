import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { RiskFlag } from '../extraction/rules';
import { PrismaService } from '../prisma/prisma.service';

export interface FlagInput {
  account: string;
  reason: string;
  source: 'invoice' | 'attack';
  amount?: string | null;
  invoiceId?: string | null;
}

/**
 * Remembers every account an invoice or an attack tried to get paid. A later attempt to allowlist one of them
 * (new payee or account change) is refused unless the caller acknowledges the warning.
 */
@Injectable()
export class FlaggedService implements OnApplicationBootstrap {
  constructor(private readonly prisma: PrismaService) {}

  /** Backfill from invoices blocked before this table existed (create-only, so restarts don't inflate hits). */
  async onApplicationBootstrap() {
    const blocked = await this.prisma.invoice.findMany({ where: { status: 'blocked' }, select: { id: true, companyId: true, amount: true, riskFlags: true } });
    for (const inv of blocked) {
      for (const t of FlaggedService.targetsFromFlags((inv.riskFlags ?? []) as unknown as RiskFlag[], inv.amount)) {
        const account = t.account.toLowerCase();
        await this.prisma.flaggedAddress.upsert({
          where: { companyId_account: { companyId: inv.companyId, account } },
          create: { companyId: inv.companyId, account, reason: t.reason, source: 'invoice', amount: t.amount ?? null, invoiceId: inv.id },
          update: {},
        });
      }
    }
  }

  async record(companyId: string, f: FlagInput) {
    const account = f.account.trim().toLowerCase();
    if (!account) return null;
    const existing = await this.prisma.flaggedAddress.findUnique({ where: { companyId_account: { companyId, account } } });
    if (existing) {
      const bigger = f.amount && (!existing.amount || BigInt(f.amount) > BigInt(existing.amount)) ? f.amount : existing.amount;
      return this.prisma.flaggedAddress.update({
        where: { id: existing.id },
        data: { hits: { increment: 1 }, lastSeen: new Date(), amount: bigger, reason: f.reason, source: existing.source === 'invoice' ? 'invoice' : f.source },
      });
    }
    return this.prisma.flaggedAddress.create({
      data: { companyId, account, reason: f.reason, source: f.source, amount: f.amount ?? null, invoiceId: f.invoiceId ?? null },
    });
  }

  /** Accounts named by blocking flags that are not the allowlisted payee. */
  static targetsFromFlags(flags: RiskFlag[], fallbackAmount?: string | null): { account: string; reason: string; amount?: string | null }[] {
    const out: { account: string; reason: string; amount?: string | null }[] = [];
    for (const f of flags) {
      if (f.code === 'PROMPT_INJECTION') {
        const t = f.data?.target as { account?: string; amount?: string } | undefined;
        if (t?.account) out.push({ account: t.account, reason: f.code, amount: t.amount ?? fallbackAmount });
      } else if (f.code === 'PAYEE_MISMATCH' && f.severity === 'block' && typeof f.data?.claimedAccount === 'string') {
        if (f.data.claimedAccount !== f.data.allowlistedAccount) out.push({ account: f.data.claimedAccount, reason: f.code, amount: fallbackAmount });
      }
    }
    return out;
  }

  async recordFromFlags(companyId: string, flags: RiskFlag[], source: 'invoice' | 'attack', amount?: string | null, invoiceId?: string | null) {
    for (const t of FlaggedService.targetsFromFlags(flags, amount)) await this.record(companyId, { ...t, source, invoiceId });
  }

  find(companyId: string, account: string) {
    return this.prisma.flaggedAddress.findUnique({ where: { companyId_account: { companyId, account: account.trim().toLowerCase() } } });
  }

  list(companyId: string, take = 50) {
    return this.prisma.flaggedAddress.findMany({ where: { companyId }, orderBy: { lastSeen: 'desc' }, take });
  }
}
