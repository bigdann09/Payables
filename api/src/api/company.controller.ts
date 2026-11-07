import { Body, Controller, Get, NotFoundException, Patch } from '@nestjs/common';
import { z } from 'zod';
import { ActivityService } from '../activity/activity.service';
import { CompanyId } from '../common/company.decorator';
import { baseUnits, ZodPipe } from '../common/zod.pipe';
import { config, mocks } from '../config';
import { NearService } from '../near/near.service';
import { PrismaService } from '../prisma/prisma.service';

const PatchCompany = z.object({
  autoPayLimit: baseUnits.optional(),
  dailyCap: baseUnits.optional(),
  telegramChatId: z.string().trim().nullable().optional(),
  notifyEmail: z.union([z.email(), z.literal(''), z.null()]).optional(),
});

@Controller()
export class CompanyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly near: NearService,
    private readonly activity: ActivityService,
  ) {}

  private async load(companyId: string) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException(`Company ${companyId} not found`);
    return company;
  }

  @Get('company')
  async get(@CompanyId() companyId: string) {
    const company = await this.load(companyId);
    const [onChain, dailySpent] = await Promise.all([this.near.getConfig(), this.near.getDailySpent()]);
    return {
      ...company,
      onChain,
      dailySpent,
      integrations: {
        chain: this.near.simulated ? 'simulated' : config.near.networkId,
        storage: mocks.storage ? 'local' : 'r2',
        extractor: mocks.extractor ? 'mock' : 'near-ai',
        telegram: mocks.telegram ? 'mock' : 'live',
        email: mocks.email ? 'mock' : 'live',
      },
    };
  }

  @Patch('company')
  async patch(@CompanyId() companyId: string, @Body(new ZodPipe(PatchCompany)) body: z.output<typeof PatchCompany>) {
    const company = await this.load(companyId);
    const autoPayLimit = body.autoPayLimit ?? company.autoPayLimit;
    const dailyCap = body.dailyCap ?? company.dailyCap;
    if (autoPayLimit !== company.autoPayLimit || dailyCap !== company.dailyCap) {
      const tx = await this.near.setLimits(autoPayLimit, dailyCap);
      await this.activity.record(companyId, 'limits_updated', `Limits set: auto-pay ${autoPayLimit}, daily cap ${dailyCap}`, {
        txHash: tx.txHash,
        autoPayLimit,
        dailyCap,
      });
    }
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        autoPayLimit,
        dailyCap,
        telegramChatId: body.telegramChatId === undefined ? undefined : body.telegramChatId || null,
        notifyEmail: body.notifyEmail === undefined ? undefined : body.notifyEmail || null,
      },
    });
    return this.get(companyId);
  }

  @Get('stats')
  async stats(@CompanyId() companyId: string) {
    const company = await this.load(companyId);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [paid, pendingApprovals, blockedCount, treasuryBalance, dailySpent, onChain] = await Promise.all([
      this.prisma.invoice.findMany({ where: { companyId, status: 'paid', paidAt: { gte: monthStart } }, select: { amount: true } }),
      this.prisma.invoice.count({ where: { companyId, status: 'pending_approval' } }),
      this.prisma.invoice.count({ where: { companyId, status: 'blocked' } }),
      this.near.getTreasuryBalance(),
      this.near.getDailySpent(),
      this.near.getConfig(),
    ]);
    const paidThisMonth = paid.reduce((s, i) => s + BigInt(i.amount ?? '0'), 0n).toString();
    return {
      treasuryBalance: treasuryBalance ?? '0',
      paidThisMonth,
      pendingApprovals,
      blockedCount,
      dailySpent: dailySpent ?? '0',
      dailyCap: (onChain?.daily_cap as string | undefined) ?? company.dailyCap,
    };
  }
}
