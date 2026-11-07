import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ActivityService } from '../activity/activity.service';
import { baseUnits, nearAccountId, ZodPipe } from '../common/zod.pipe';
import { CompanyId } from '../common/company.decorator';
import { FlaggedService } from '../flagged/flagged.service';
import { NearService } from '../near/near.service';
import { PrismaService } from '../prisma/prisma.service';

/** `acknowledgeFlag` overrides the flagged-address warning (the account was used in a blocked invoice or attack). */
const CreatePayee = z.object({ name: z.string().trim().min(1), email: z.email(), nearAccountId, acknowledgeFlag: z.boolean().optional() });
const UpdatePayee = z.object({
  name: z.string().trim().min(1).optional(),
  email: z.email().optional(),
  nearAccountId: nearAccountId.optional(),
  acknowledgeFlag: z.boolean().optional(),
});
const CreatePo = z.object({
  payeeId: z.string().min(1),
  number: z.string().trim().min(1),
  amount: baseUnits,
  description: z.string().trim().default(''),
  status: z.enum(['open', 'closed']).optional(),
});

@Controller()
export class PayeesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly near: NearService,
    private readonly activity: ActivityService,
    private readonly flagged: FlaggedService,
  ) {}

  @Get('flagged-addresses')
  listFlagged(@CompanyId() companyId: string) {
    return this.flagged.list(companyId, 100);
  }

  /** Refuses to allowlist an account that a blocked invoice or attack tried to get paid, unless acknowledged. */
  private async guardFlagged(companyId: string, account: string, acknowledged: boolean | undefined, context: string) {
    const hit = await this.flagged.find(companyId, account);
    if (!hit) return;
    if (!acknowledged) {
      throw new ConflictException({
        statusCode: 409,
        code: 'FLAGGED_ADDRESS',
        message: `${account} is a flagged address: a blocked ${hit.source === 'attack' ? 'attack' : 'invoice'} tried to get it paid (${hit.reason}, ${hit.hits}×). Confirm to continue.`,
        flagged: hit,
      });
    }
    await this.activity.record(companyId, 'flag_overridden', `Flag warning overridden for ${account} (${context})`, { account, reason: hit.reason });
  }

  @Get('payees')
  list(@CompanyId() companyId: string) {
    return this.prisma.payee.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } });
  }

  /** Registers the payee on-chain (owner key; contract also storage_deposits USDC for them). */
  @Post('payees')
  async create(@CompanyId() companyId: string, @Body(new ZodPipe(CreatePayee)) body: z.output<typeof CreatePayee>) {
    if (await this.prisma.payee.findFirst({ where: { companyId, nearAccountId: body.nearAccountId } })) {
      throw new ConflictException(`Payee ${body.nearAccountId} already exists`);
    }
    await this.guardFlagged(companyId, body.nearAccountId, body.acknowledgeFlag, `new payee ${body.name}`);
    const tx = await this.near.registerPayee(body.nearAccountId, body.name);
    const payee = await this.prisma.payee.create({ data: { companyId, name: body.name, email: body.email, nearAccountId: body.nearAccountId, status: 'active' } });
    await this.activity.record(companyId, 'payee_registered', `Payee ${body.name} (${body.nearAccountId}) registered on-chain`, {
      txHash: tx.txHash,
      payeeId: payee.id,
    });
    return payee;
  }

  /** Name/email update directly; an account change opens a DAO proposal and sets status pending_change. */
  @Patch('payees/:id')
  async update(@CompanyId() companyId: string, @Param('id') id: string, @Body(new ZodPipe(UpdatePayee)) body: z.output<typeof UpdatePayee>) {
    const payee = await this.prisma.payee.findFirst({ where: { id, companyId } });
    if (!payee) throw new NotFoundException(`Payee ${id} not found`);
    const data: Record<string, unknown> = {};
    if (body.name) data.name = body.name;
    if (body.email) data.email = body.email;
    if (body.nearAccountId && body.nearAccountId !== payee.nearAccountId) {
      if (payee.status === 'pending_change') throw new ConflictException('An account change is already awaiting DAO approval');
      await this.guardFlagged(companyId, body.nearAccountId, body.acknowledgeFlag, `account change for ${payee.name}`);
      const tx = await this.near.requestPayeeChange(payee.nearAccountId, body.nearAccountId);
      Object.assign(data, { status: 'pending_change', pendingNearAccountId: body.nearAccountId, pendingChangeProposalId: tx.proposalId ?? null });
      await this.activity.record(
        companyId,
        'payee_change_requested',
        `Account change for ${payee.name}: ${payee.nearAccountId} → ${body.nearAccountId}; DAO proposal opened`,
        { txHash: tx.txHash, payeeId: payee.id, proposalId: tx.proposalId ?? null },
      );
    }
    return this.prisma.payee.update({ where: { id }, data });
  }

  @Get('purchase-orders')
  listPos(@CompanyId() companyId: string) {
    return this.prisma.purchaseOrder.findMany({ where: { companyId }, include: { payee: true }, orderBy: { createdAt: 'asc' } });
  }

  @Post('purchase-orders')
  async createPo(@CompanyId() companyId: string, @Body(new ZodPipe(CreatePo)) body: z.output<typeof CreatePo>) {
    if (!(await this.prisma.payee.findFirst({ where: { id: body.payeeId, companyId } }))) throw new BadRequestException(`Unknown payeeId ${body.payeeId}`);
    if (await this.prisma.purchaseOrder.findFirst({ where: { companyId, number: body.number } })) {
      throw new ConflictException(`Purchase order ${body.number} already exists`);
    }
    const po = await this.prisma.purchaseOrder.create({ data: { companyId, ...body }, include: { payee: true } });
    await this.activity.record(companyId, 'po_created', `Purchase order ${po.number} created for ${po.payee.name}`, { poId: po.id });
    return po;
  }
}
