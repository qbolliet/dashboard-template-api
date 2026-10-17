/**
 * Tests of the export concurrency gate (src/export/concurrency-gate.ts).
 */

import { describe, test, expect } from '@jest/globals';
import { ExportConcurrencyGate } from '../../../src/export/concurrency-gate.js';
import { clientIp } from '../../../src/security/rate-limiter.js';

describe('ExportConcurrencyGate', () => {
  test('refuses a client beyond its ceiling, other clients unaffected', () => {
    const gate = new ExportConcurrencyGate(2, 10);
    const a1 = gate.tryAcquire('a');
    const a2 = gate.tryAcquire('a');

    expect(a1.ok && a2.ok).toBe(true);
    expect(gate.tryAcquire('a')).toEqual({ ok: false, reason: 'client' });
    expect(gate.tryAcquire('b').ok).toBe(true);
    expect(gate.activeCount('a')).toBe(2);
    expect(gate.activeCount()).toBe(3);
  });

  test('refuses everyone beyond the global ceiling', () => {
    const gate = new ExportConcurrencyGate(5, 2);
    gate.tryAcquire('a');
    gate.tryAcquire('b');

    expect(gate.tryAcquire('c')).toEqual({ ok: false, reason: 'total' });
  });

  test('release is idempotent and frees the slot', () => {
    const gate = new ExportConcurrencyGate(1, 1);
    const slot = gate.tryAcquire('a');
    if (!slot.ok) throw new Error('slot expected');

    slot.release();
    slot.release();

    expect(gate.activeCount()).toBe(0);
    expect(gate.activeCount('a')).toBe(0);
    expect(gate.tryAcquire('a').ok).toBe(true);
  });
});

// Résolution de x-forwarded-for couverte par tests/integration/rate-limit.test.ts
// (trust proxy réel d'Express) : clientIp ne fait que lire req.ip
describe('clientIp (key of the gate)', () => {
  test('uses req.ip as computed by Express, whatever x-forwarded-for says', () => {
    const req = {
      ip: '203.0.113.9',
      socket: { remoteAddress: '10.0.0.1' },
      headers: { 'x-forwarded-for': '6.6.6.6', 'user-agent': 'a' },
    };
    expect(clientIp(req)).toBe('203.0.113.9');
  });

  test('falls back to the socket address, then to "unknown"', () => {
    expect(clientIp({ socket: { remoteAddress: '10.0.0.1' }, headers: {} })).toBe('10.0.0.1');
    expect(clientIp({ headers: {} })).toBe('unknown');
  });
});
