export const USDC_DECIMALS = 6;

/** "1,850.00" | "1850" | 1850.5 → "1850500000" (USDC base units). Throws on garbage. */
export function toBaseUnits(value: string | number, decimals = USDC_DECIMALS): string {
  let s = typeof value === 'number' ? value.toFixed(decimals) : value;
  s = s.replace(/[,\s_]/g, '').replace(/^(USDC|USD|\$)/i, '').replace(/(USDC|USD)$/i, '');
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount: ${value}`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) throw new Error(`Too many decimals: ${value}`);
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || '0')).toString();
}

/** "1850500000" → "1,850.50" */
export function formatUsdc(base: string | bigint, decimals = USDC_DECIMALS): string {
  const b = BigInt(base);
  const whole = b / 10n ** BigInt(decimals);
  const frac = (b % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').slice(0, 2);
  return `${whole.toLocaleString('en-US')}.${frac}`;
}

export function isBaseUnits(s: unknown): s is string {
  return typeof s === 'string' && /^\d+$/.test(s);
}
