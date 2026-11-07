import { Injectable, Logger } from '@nestjs/common';
import { Api } from 'grammy';
import { Resend } from 'resend';
import { formatUsdc } from '../common/amount';
import { config, mocks } from '../config';
import { NearService } from '../near/near.service';
import type { NotifyType } from '../queues/queue-names';

export interface NotifyContext {
  type: NotifyType;
  invoice: {
    id: string;
    number: string | null;
    amount: string | null;
    status: string;
    txHash: string | null;
    daoProposalId: string | null;
    riskFlags: unknown;
  };
  payeeName?: string;
  company: { name: string; daoId: string; telegramChatId: string | null; notifyEmail: string | null };
}

export interface RenderedMessage {
  subject: string;
  text: string;
  html: string;
  link?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Telegram (grammY Api) + email (Resend). Each channel logs to console instead when unconfigured. */
@Injectable()
export class NotifierService {
  private readonly log = new Logger('Notify');
  private readonly tg?: Api;
  private readonly resend?: Resend;

  constructor(private readonly near: NearService) {
    if (mocks.telegram) this.log.warn('[MOCK] TELEGRAM_BOT_TOKEN not set; Telegram messages are printed to the console');
    else this.tg = new Api(config.telegram.botToken!);
    if (mocks.email) this.log.warn('[MOCK] RESEND_API_KEY not set; emails are printed to the console');
    else this.resend = new Resend(config.email.resendApiKey);
  }

  render(ctx: NotifyContext): RenderedMessage {
    const inv = ctx.invoice;
    const label = `${inv.number ?? inv.id}${ctx.payeeName ? ` from ${ctx.payeeName}` : ''}`;
    const amount = inv.amount ? `${formatUsdc(inv.amount)} USDC` : 'unknown amount';
    const detail = `${config.webUrl}/invoices/${inv.id}`;
    switch (ctx.type) {
      case 'paid': {
        const link = inv.txHash ? this.near.explorerTxUrl(inv.txHash) : detail;
        return this.msg(`Paid: ${label}`, `✅ Paid ${amount} for invoice ${label}.`, link, 'View transaction');
      }
      case 'approval_needed': {
        const link = inv.daoProposalId ? this.near.daoProposalUrl(ctx.company.daoId, inv.daoProposalId) : detail;
        return this.msg(
          `Approval needed: ${label}`,
          `🗳 Approval needed: invoice ${label} for ${amount} is above the auto-pay limit. DAO proposal #${inv.daoProposalId ?? '?'} is open.`,
          link,
          'Vote on the proposal',
        );
      }
      case 'blocked': {
        const flags = Array.isArray(inv.riskFlags) ? (inv.riskFlags as { severity: string; message: string }[]) : [];
        const reasons = flags.filter((f) => f.severity === 'block').map((f) => `• ${f.message}`);
        return this.msg(`Blocked: ${label}`, `⛔ Blocked invoice ${label} (${amount}).\n${reasons.join('\n')}`, detail, 'Review invoice');
      }
      case 'failed':
        return this.msg(`Payment failed: ${label}`, `⚠️ Payment failed for invoice ${label} (${amount}).`, detail, 'Review invoice');
    }
  }

  private msg(subject: string, body: string, link: string, linkText: string): RenderedMessage {
    return {
      subject,
      text: `${body}\n${linkText}: ${link}`,
      html: `<p>${esc(body).replace(/\n/g, '<br>')}</p><p><a href="${esc(link)}">${esc(linkText)}</a></p>`,
      link,
    };
  }

  /** Plain Telegram alert (red-team attacks). Never throws. */
  async sendTelegramText(chatId: string | null | undefined, subject: string, body: string, link?: string): Promise<string> {
    const target = chatId ?? config.telegram.defaultChatId;
    const html = `<b>${esc(subject)}</b>\n${esc(body)}${link ? `\n<a href="${esc(link)}">View transaction</a>` : ''}`;
    if (!this.tg) {
      this.log.log(`[MOCK telegram → ${target ?? 'no-chat-id'}] ${subject} | ${body}`);
      return 'mock';
    }
    if (!target) return 'skipped (no chat id)';
    try {
      await this.tg.sendMessage(target, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      return 'sent';
    } catch (e) {
      this.log.warn(`telegram alert failed: ${(e as Error).message}`);
      return 'failed';
    }
  }

  /** Sends on every configured channel. Throws if a real send fails, so BullMQ retries with backoff. */
  async send(ctx: NotifyContext): Promise<{ telegram: string; email: string }> {
    const m = this.render(ctx);
    const chatId = ctx.company.telegramChatId ?? config.telegram.defaultChatId;
    let telegram = 'skipped (no chat id)';
    if (this.tg && chatId) {
      await this.tg.sendMessage(chatId, `<b>${esc(m.subject)}</b>\n${m.html.replace(/<\/?p>/g, '\n').replace(/<br>/g, '\n')}`, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      telegram = 'sent';
    } else if (!this.tg) {
      this.log.log(`[MOCK telegram → ${chatId ?? 'no-chat-id'}] ${m.text.replace(/\n/g, ' | ')}`);
      telegram = 'mock';
    }

    let email = 'skipped (no notifyEmail)';
    if (this.resend && ctx.company.notifyEmail) {
      const { error } = await this.resend.emails.send({ from: config.email.from, to: ctx.company.notifyEmail, subject: m.subject, html: m.html, text: m.text });
      if (error) throw new Error(`Resend: ${error.message}`);
      email = 'sent';
    } else if (!this.resend) {
      this.log.log(`[MOCK email → ${ctx.company.notifyEmail ?? 'no-address'}] ${m.subject}`);
      email = 'mock';
    }
    return { telegram, email };
  }
}
