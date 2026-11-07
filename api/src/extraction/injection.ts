import { toBaseUnits } from '../common/amount';

/** Patterns of instruction-like text that has no business in an invoice. */
const PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|polic(y|ies)|guidelines?)/i, label: 'override-instructions' },
  { re: /\b(new|updated|revised|real)\s+instructions?\s*:/i, label: 'new-instructions' },
  { re: /\b(system|developer)\s*(prompt|message|note)\b/i, label: 'system-prompt' },
  { re: /\b(you are|act as|pretend to be)\s+(now\s+)?(an?|the)\s+\w+/i, label: 'role-play' },
  { re: /\b(note|message|instructions?)\s+(to|for)\s+(the\s+)?(ai|llm|agent|assistant|model|bot)\b/i, label: 'addressed-to-ai' },
  { re: /\b(ai|llm|agent|assistant|model)\s*[:,]\s*(please\s+)?(pay|send|transfer|approve|mark|ignore)/i, label: 'addressed-to-ai' },
  { re: /\b(do not|don't|never)\s+(flag|report|verify|check|escalate|mention)\b/i, label: 'suppress-checks' },
  { re: /\bmark\s+(this|the)\s+invoice\s+as\s+(verified|approved|paid|safe)/i, label: 'self-approval' },
  { re: /\b(auto-?approve|pre-?approved|already\s+approved\s+by)\b/i, label: 'self-approval' },
  { re: /<\|?(im_start|im_end|system|assistant|endoftext)\|?>|\[\/?INST\]|###\s*(system|instruction)/i, label: 'chat-markup' },
];

const ACCOUNT_RE = /\b([a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)*\.(?:testnet|near))\b/gi;
const PAY_TO_RE =
  /\b(?:pay|send|transfer|wire)\s+(?:(?:the\s+)?(?:sum\s+of\s+)?\$?([\d][\d,]*(?:\.\d+)?)\s*(?:k\b)?\s*(?:usdc|usd|dollars)?\s+)?to\s+([a-z0-9._-]+\.(?:testnet|near))/i;

export interface InjectionFinding {
  detected: boolean;
  matches: { label: string; excerpt: string }[];
  /** Payment the injected text tries to induce, if any (used only for the "forced" demo path). */
  target?: { account: string; amount?: string };
}

export function detectPromptInjection(text: string): InjectionFinding {
  const matches: { label: string; excerpt: string }[] = [];
  for (const { re, label } of PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      const start = Math.max(lineStart, m.index - 60);
      matches.push({ label, excerpt: text.slice(start, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim() });
    }
  }
  const detected = matches.length > 0;
  let target: InjectionFinding['target'];
  if (detected) {
    const p = PAY_TO_RE.exec(text);
    if (p) {
      let amount: string | undefined;
      try {
        amount = p[1] ? toBaseUnits(p[1]) : undefined;
      } catch {
        amount = undefined;
      }
      target = { account: p[2].toLowerCase(), amount };
    }
  }
  return { detected, matches, target };
}

export function nearAccountsIn(text: string): string[] {
  return [...new Set([...text.matchAll(ACCOUNT_RE)].map((m) => m[1].toLowerCase()))];
}
