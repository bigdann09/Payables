import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ActivityService } from '../activity/activity.service';
import { CompanyId } from '../common/company.decorator';
import { ZodPipe } from '../common/zod.pipe';
import { $Enums } from '../generated/prisma/client';
import { PipelineService } from '../invoices/pipeline.service';
import { PrismaService } from '../prisma/prisma.service';
import { sha256Hex, StorageService } from '../storage/storage.service';

const STATUSES = Object.values($Enums.InvoiceStatus) as [string, ...string[]];
const PayNow = z.object({ force: z.boolean().optional().default(false) });

@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly pipeline: PipelineService,
    private readonly activity: ActivityService,
  ) {}

  @Get()
  async list(@CompanyId() companyId: string, @Query('status') status?: string) {
    const statuses = status ? status.split(',').map((s) => s.trim()) : undefined;
    if (statuses?.some((s) => !STATUSES.includes(s))) throw new BadRequestException(`status must be one of ${STATUSES.join(', ')}`);
    return this.prisma.invoice.findMany({
      where: { companyId, ...(statuses ? { status: { in: statuses as $Enums.InvoiceStatus[] } } : {}) },
      include: { payee: true, po: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Get(':id')
  async get(@CompanyId() companyId: string, @Param('id') id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, companyId },
      include: { payee: true, po: true, activity: { orderBy: { createdAt: 'asc' } } },
    });
    if (!invoice) throw new NotFoundException(`Invoice ${id} not found`);
    const pdfUrl = await this.storage.signedUrl(invoice.pdfKey);
    return { ...invoice, pdfUrl };
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async upload(@CompanyId() companyId: string, @UploadedFile() file: Express.Multer.File | undefined, @Body('payeeId') payeeId?: string) {
    if (!file) throw new BadRequestException('multipart field "file" (PDF) is required');
    const bytes = new Uint8Array(file.buffer);
    if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new BadRequestException('file must be a PDF');
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException(`Company ${companyId} not found`);
    if (payeeId && !(await this.prisma.payee.findFirst({ where: { id: payeeId, companyId } }))) {
      throw new BadRequestException(`Unknown payeeId ${payeeId}`);
    }

    const hash = sha256Hex(bytes);
    const key = `invoices/${companyId}/${hash.slice(0, 16)}-${randomUUID()}.pdf`;
    await this.storage.put(key, bytes);
    const invoice = await this.prisma.invoice.create({
      data: { companyId, pdfKey: key, pdfHash: hash, status: 'received', payeeId: payeeId || null, extracted: {}, riskFlags: [] },
    });
    await this.activity.record(
      companyId,
      'received',
      `Invoice PDF received (${file.originalname}, ${bytes.length} bytes)`,
      { fileName: file.originalname, sha256: hash, storage: this.storage.mode },
      invoice.id,
    );
    await this.pipeline.enqueueExtract(invoice.id, payeeId || undefined);
    return invoice;
  }

  @Post(':id/pay-now')
  @HttpCode(202)
  async payNow(@CompanyId() companyId: string, @Param('id') id: string, @Body(new ZodPipe(PayNow)) body: z.output<typeof PayNow>) {
    const invoice = await this.prisma.invoice.findFirst({ where: { id, companyId } });
    if (!invoice) throw new NotFoundException(`Invoice ${id} not found`);
    const allowed = ['scheduled', 'needs_review'];
    if (invoice.status === 'blocked' && !body.force) {
      throw new ConflictException('Invoice is blocked by rule checks; pass {"force": true} to submit anyway (demo: the contract will refuse)');
    }
    if (invoice.status !== 'blocked' && !allowed.includes(invoice.status)) {
      throw new ConflictException(`Invoice is ${invoice.status}; pay-now needs scheduled, needs_review or blocked (+force)`);
    }
    await this.pipeline.payNow(invoice, body.force);
    return { ...invoice, queued: true };
  }
}
