import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { config } from '../config';
import { NearService } from '../near/near.service';
import { PrismaService } from '../prisma/prisma.service';
import { PipelineService } from './pipeline.service';

/**
 * Polls the policy contract for invoices whose final state is decided asynchronously
 * (DAO vote → release_payment / reject_payment, or a pending ft_transfer callback).
 */
@Injectable()
export class ChainSyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('ChainSync');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly near: NearService,
    private readonly pipeline: PipelineService,
  ) {}

  onApplicationBootstrap() {
    if (this.near.simulated) return; // simulator updates are applied directly by the dev DAO endpoints
    this.timer = setInterval(() => void this.tick(), config.chainSyncIntervalMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const open = await this.prisma.invoice.findMany({ where: { status: { in: ['pending_approval', 'paying'] }, txHash: { not: null } } });
      for (const inv of open) {
        let chain = await this.near.getInvoice(inv.id);
        if (chain?.status === 'pending_approval' && inv.daoProposalId && (await this.daoSaidNo(inv.daoProposalId))) {
          await this.near.rejectPayment(inv.id);
          this.log.log(`DAO proposal #${inv.daoProposalId} did not pass; rejected invoice ${inv.number ?? inv.id} on-chain`);
          chain = await this.near.getInvoice(inv.id);
        }
        if (chain) await this.pipeline.syncFromChain(inv.id, chain);
      }
      const pendingPayees = await this.prisma.payee.findMany({ where: { status: 'pending_change', pendingNearAccountId: { not: null } } });
      for (const p of pendingPayees) {
        if (p.pendingChangeProposalId && (await this.daoSaidNo(p.pendingChangeProposalId))) {
          await this.near.rejectPayeeChange(p.nearAccountId);
          await this.prisma.payee.update({
            where: { id: p.id },
            data: { pendingNearAccountId: null, pendingChangeProposalId: null, status: 'active' },
          });
          this.log.log(`Payee ${p.name} account change rejected by DAO`);
          continue;
        }
        if (await this.near.getPayee(p.pendingNearAccountId!)) {
          await this.prisma.payee.update({
            where: { id: p.id },
            data: { nearAccountId: p.pendingNearAccountId!, pendingNearAccountId: null, status: 'active' },
          });
          this.log.log(`Payee ${p.name} account change approved by DAO`);
        }
      }
    } catch (e) {
      this.log.warn(`sync failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Sputnik records a failed vote on the proposal but never notifies the policy contract. */
  private async daoSaidNo(proposalId: string): Promise<boolean> {
    const status = await this.near.getDaoProposalStatus(proposalId);
    return status === 'Rejected' || status === 'Removed' || status === 'Expired';
  }
}
