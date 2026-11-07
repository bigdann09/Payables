import { BadRequestException, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ActivityService } from '../activity/activity.service';
import { CompanyId } from '../common/company.decorator';
import { PipelineService } from '../invoices/pipeline.service';
import { NearService } from '../near/near.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

@Controller()
export class MiscController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly near: NearService,
    private readonly pipeline: PipelineService,
    private readonly activity: ActivityService,
  ) {}

  @Get('health')
  health() {
    return { ok: true, chain: this.near.simulated ? 'simulated' : 'near', storage: this.storage.mode };
  }

  @Get('activity')
  list(@CompanyId() companyId: string, @Query('limit') limit?: string, @Query('invoiceId') invoiceId?: string) {
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return this.prisma.activityLog.findMany({
      where: { companyId, ...(invoiceId ? { invoiceId } : {}) },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /** Serves locally stored files behind an HMAC-signed, expiring URL (R2 fallback). */
  @Get('files')
  async file(@Query('key') key: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    if (!key || !exp || !sig) throw new BadRequestException('key, exp and sig are required');
    if (!this.storage.verifyLocalSignature(key, Number(exp), sig)) throw new ForbiddenException('Invalid or expired signature');
    const body = await this.storage.get(key).catch(() => {
      throw new NotFoundException('File not found');
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.send(Buffer.from(body));
  }

  // ---------------------------------------------------------------- simulated DAO (demo only)

  private requireSim() {
    if (!this.near.simulated) throw new ForbiddenException('Only available with the simulated chain; vote on AstroDAO on testnet');
  }

  /** Simulate a passed DAO vote: the DAO calls release_payment(invoice_id). */
  @Post('dev/dao/invoices/:id/approve')
  async approve(@CompanyId() companyId: string, @Param('id') id: string) {
    this.requireSim();
    const inv = await this.prisma.invoice.findFirst({ where: { id, companyId } });
    if (!inv) throw new NotFoundException(`Invoice ${id} not found`);
    const r = this.near.simDaoRelease(id);
    await this.activity.record(companyId, 'dao_approved', `DAO proposal #${inv.daoProposalId} approved; release_payment called`, { txHash: r.txHash }, id);
    await this.pipeline.applyPaymentResult(id, r);
    return this.prisma.invoice.findUnique({ where: { id } });
  }

  @Post('dev/dao/invoices/:id/reject')
  async reject(@CompanyId() companyId: string, @Param('id') id: string) {
    this.requireSim();
    const inv = await this.prisma.invoice.findFirst({ where: { id, companyId } });
    if (!inv) throw new NotFoundException(`Invoice ${id} not found`);
    const r = this.near.simDaoReject(id);
    await this.pipeline.applyPaymentResult(id, r);
    return this.prisma.invoice.findUnique({ where: { id } });
  }

  @Post('dev/dao/payees/:id/approve')
  async approvePayee(@CompanyId() companyId: string, @Param('id') id: string) {
    this.requireSim();
    const p = await this.prisma.payee.findFirst({ where: { id, companyId } });
    if (!p || p.status !== 'pending_change' || !p.pendingNearAccountId || p.pendingChangeProposalId == null) {
      throw new NotFoundException('No pending payee change');
    }
    const tx = this.near.simDaoApprovePayeeChange(Number(p.pendingChangeProposalId));
    const updated = await this.prisma.payee.update({
      where: { id },
      data: { nearAccountId: p.pendingNearAccountId, pendingNearAccountId: null, pendingChangeProposalId: null, status: 'active' },
    });
    await this.activity.record(companyId, 'payee_change_approved', `DAO approved account change for ${p.name} → ${updated.nearAccountId}`, {
      txHash: tx.txHash,
      payeeId: id,
    });
    return updated;
  }
}
