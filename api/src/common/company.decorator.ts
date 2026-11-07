import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { config } from '../config';

/** Demo "auth": company id from the `x-company-id` header, falling back to COMPANY_ID. */
export const CompanyId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
  return req.headers['x-company-id']?.trim() || config.companyId;
});
