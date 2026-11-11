import { Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CompanyId } from '../common/company.decorator';
import { SamplesService } from './samples.service';

const ip = (req: Request) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.ip || 'unknown';

/** Public "try a sample" invoices for the contractor portal (no login, rate limited). */
@Controller('samples')
export class SamplesController {
  constructor(private readonly samples: SamplesService) {}

  @Get()
  list(@CompanyId() companyId: string) {
    return this.samples.list(companyId);
  }

  /** A fresh PDF to download and upload by hand. */
  @Get(':id/pdf')
  async pdf(@CompanyId() companyId: string, @Param('id') id: string, @Res() res: Response) {
    const { bytes, fileName } = await this.samples.pdf(companyId, id);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `attachment; filename="${fileName}"`);
    res.send(Buffer.from(bytes));
  }

  /** Renders a fresh sample and submits it through the normal intake pipeline. */
  @Post(':id')
  @HttpCode(201)
  submit(@CompanyId() companyId: string, @Param('id') id: string, @Req() req: Request) {
    return this.samples.submit(companyId, id, ip(req));
  }
}
