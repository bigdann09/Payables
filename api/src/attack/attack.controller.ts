import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { z } from 'zod';
import { toBaseUnits } from '../common/amount';
import { nearAccountId, ZodPipe } from '../common/zod.pipe';
import { config } from '../config';
import { FlaggedService } from '../flagged/flagged.service';
import { AttackService } from './attack.service';

const Direct = z.object({
  account: nearAccountId,
  /** Decimal USDC, e.g. "50000" or "12.5" */
  amount: z
    .union([z.string(), z.number()])
    .transform((v, ctx) => {
      try {
        const b = toBaseUnits(String(v));
        if (BigInt(b) <= 0n || BigInt(b) > 10n ** 18n) throw new Error('out of range');
        return b;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'amount must be a positive USDC amount' });
        return z.NEVER;
      }
    }),
});

const ip = (req: Request) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.ip || 'unknown';

/** Public, wallet-less judge mode. See AttackService for the "never moves funds" invariant. */
@Controller('attack')
export class AttackController {
  constructor(
    private readonly attacks: AttackService,
    private readonly flagged: FlaggedService,
  ) {}

  @Get()
  async info() {
    return { ...this.attacks.info(), flagged: await this.flagged.list(config.companyId, 20) };
  }

  @Post('preset/:id')
  @HttpCode(200)
  preset(@Param('id') id: string, @Req() req: Request) {
    return this.attacks.runPreset(id, ip(req));
  }

  @Post('direct')
  @HttpCode(200)
  direct(@Body(new ZodPipe(Direct)) body: z.output<typeof Direct>, @Req() req: Request) {
    return this.attacks.runDirect(body.account, body.amount, ip(req));
  }

  @Post('upload')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  upload(@UploadedFile() file: Express.Multer.File | undefined, @Req() req: Request) {
    if (!file) throw new BadRequestException('multipart field "file" (PDF, max 2 MB) is required');
    return this.attacks.runUpload(new Uint8Array(file.buffer), file.originalname, ip(req));
  }
}
