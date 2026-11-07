import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ActivityService {
  private readonly log = new Logger('Activity');
  constructor(private readonly prisma: PrismaService) {}

  async record(companyId: string, type: string, message: string, data: Record<string, unknown> = {}, invoiceId?: string) {
    this.log.log(`${type}${invoiceId ? ` [${invoiceId}]` : ''}: ${message}`);
    return this.prisma.activityLog.create({
      data: { companyId, invoiceId, type, message, data: JSON.parse(JSON.stringify(data)) },
    });
  }
}
