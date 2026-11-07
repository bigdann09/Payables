import { describe, expect, it } from 'vitest';
import { outcomeFromEvents, parseEvents } from '../src/near/events';
import { ContractPanic, PolicySimulator } from '../src/near/policy-sim';

const USDC = (n: number) => (BigInt(n) * 1_000_000n).toString();
const cfg = {
  owner_id: 'owner.testnet',
  agent_id: 'agent.testnet',
  dao_id: 'dao.testnet',
  usdc_id: 'usdc.testnet',
  auto_pay_limit: USDC(5), // same as the testnet deployment
  daily_cap: USDC(15),
};

function setup(treasury = USDC(100), now = () => Date.UTC(2026, 10, 4, 12)) {
  const sim = new PolicySimulator(cfg, BigInt(treasury), now);
  sim.registerPayee('owner.testnet', 'alice.testnet', 'Alice');
  return sim;
}

let n = 0;
const req = (over: Partial<{ invoice_id: string; payee: string; amount: string; invoice_hash: string }> = {}) => ({
  invoice_id: `inv-${++n}`,
  payee: 'alice.testnet',
  amount: USDC(1),
  invoice_hash: `hash-${n}`,
  due_date: '2026-11-10',
  ...over,
});

describe('PolicySimulator', () => {
  it('auto-pays an allowlisted payee under the limit and emits NEP-297 events', () => {
    const sim = setup();
    const r = sim.requestPayment('agent.testnet', req());
    expect(r.value.status).toBe('paid');
    const events = parseEvents(r.logs);
    expect(events.map((e) => e.event)).toEqual(['payment_requested', 'payment_paid']);
    expect(events[0]).toMatchObject({ standard: 'payables', version: '1.0.0' });
    expect(outcomeFromEvents(events, r.value.invoice_id).status).toBe('paid');
    expect(sim.treasury).toBe(BigInt(USDC(99)));
    expect(sim.getDailySpent()).toBe(USDC(1));
    expect(r.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  it('only the agent may request payments', () => {
    expect(() => setup().requestPayment('owner.testnet', req())).toThrow(ContractPanic);
  });

  it('rejects non-allowlisted payees without changing state', () => {
    const sim = setup();
    expect(() => sim.requestPayment('agent.testnet', req({ payee: 'evil.testnet', amount: USDC(50_000) }))).toThrow(/not allowlisted/);
    expect(sim.invoices.size).toBe(0);
    expect(sim.treasury).toBe(BigInt(USDC(100)));
  });

  it('rejects a duplicate invoice hash and duplicate invoice id', () => {
    const sim = setup();
    sim.requestPayment('agent.testnet', req({ invoice_id: 'a', invoice_hash: 'h' }));
    expect(() => sim.requestPayment('agent.testnet', req({ invoice_id: 'b', invoice_hash: 'h' }))).toThrow(/hash already paid/);
    expect(() => sim.requestPayment('agent.testnet', req({ invoice_id: 'a', invoice_hash: 'h2' }))).toThrow(/already exists/);
  });

  it('pays exactly at the limit, escalates above it to a DAO proposal', () => {
    const sim = setup();
    expect(sim.requestPayment('agent.testnet', req({ amount: USDC(5) })).value.status).toBe('paid');
    const r = sim.requestPayment('agent.testnet', req({ amount: '5000001' })); // 5.000001 USDC
    expect(r.value.status).toBe('pending_approval');
    const out = outcomeFromEvents(parseEvents(r.logs), r.value.invoice_id);
    expect(out).toEqual({ status: 'pending_approval', proposalId: '0' });
    expect(sim.getDailySpent()).toBe(USDC(5));
  });

  it('escalates when the daily cap would be exceeded, and resets the next UTC day', () => {
    let t = Date.UTC(2026, 10, 4, 12);
    const sim = setup(USDC(100), () => t);
    // 3 x 5 = 15 USDC lands exactly on the cap; any further amount escalates.
    for (let i = 0; i < 3; i++) expect(sim.requestPayment('agent.testnet', req({ amount: USDC(5) })).value.status).toBe('paid');
    const over = sim.requestPayment('agent.testnet', req({ amount: USDC(1) }));
    expect(over.value.status).toBe('pending_approval');
    expect(parseEvents(over.logs)[1].data[0]).toMatchObject({ reason: 'daily_cap_exceeded' });
    t += 86_400_000;
    expect(sim.getDailySpent()).toBe('0');
    expect(sim.requestPayment('agent.testnet', req({ amount: USDC(1) })).value.status).toBe('paid');
  });

  it('DAO release pays a pending invoice without counting toward the daily cap; only the DAO may release', () => {
    const sim = setup();
    const r = sim.requestPayment('agent.testnet', req({ amount: USDC(8) }));
    expect(() => sim.releasePayment('agent.testnet', r.value.invoice_id)).toThrow(/Only the DAO/);
    const rel = sim.releasePayment('dao.testnet', r.value.invoice_id);
    expect(rel.value.status).toBe('paid');
    expect(sim.getDailySpent()).toBe('0');
    expect(() => sim.releasePayment('dao.testnet', r.value.invoice_id)).toThrow(/not pending/);
  });

  it('reject_payment by owner or DAO, and frees the hash', () => {
    const sim = setup();
    const r = sim.requestPayment('agent.testnet', req({ amount: USDC(8), invoice_hash: 'hh' }));
    expect(() => sim.rejectPayment('agent.testnet', r.value.invoice_id)).toThrow();
    expect(sim.rejectPayment('owner.testnet', r.value.invoice_id).value.status).toBe('rejected');
    expect(sim.paidHashes.has('hh')).toBe(false);
  });

  it('marks the payment failed when the treasury cannot cover it', () => {
    const sim = setup(USDC(1));
    const r = sim.requestPayment('agent.testnet', req({ amount: USDC(2) }));
    expect(r.value.status).toBe('failed');
    expect(outcomeFromEvents(parseEvents(r.logs), r.value.invoice_id).status).toBe('failed');
  });

  it('payee change goes through the DAO', () => {
    const sim = setup();
    const { value: pid } = sim.requestPayeeChange('owner.testnet', 'alice.testnet', 'alice2.testnet');
    expect(sim.getPayee('alice2.testnet')).toBeNull();
    expect(() => sim.approvePayeeChange('owner.testnet', pid)).toThrow(/Only the DAO/);
    sim.approvePayeeChange('dao.testnet', pid);
    expect(sim.getPayee('alice.testnet')).toBeNull();
    expect(sim.getPayee('alice2.testnet')).toMatchObject({ name: 'Alice' });
  });

  it('set_limits is owner-only', () => {
    const sim = setup();
    expect(() => sim.setLimits('agent.testnet', '1', '1')).toThrow();
    sim.setLimits('owner.testnet', USDC(1), USDC(2));
    expect(sim.getConfig()).toMatchObject({ auto_pay_limit: USDC(1), daily_cap: USDC(2) });
  });
});

describe('parseEvents', () => {
  it('ignores foreign standards and malformed logs', () => {
    const logs = [
      'plain log',
      'EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{}]}',
      'EVENT_JSON:{bad json',
      'EVENT_JSON:{"standard":"payables","version":"1.0.0","event":"payment_paid","data":[{"invoice_id":"x"}]}',
    ];
    expect(parseEvents(logs).map((e) => e.event)).toEqual(['payment_paid']);
  });
});
