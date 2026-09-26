/**
 * Tests of the export concurrency gate (src/export/concurrency-gate.ts).
 */

import { describe, test, expect } from '@jest/globals';
import { ExportConcurrencyGate } from '../../../src/export/concurrency-gate.js';
import { resolveClientIp } from '../../../src/security/rate-limiter.js';

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

describe('resolveClientIp (key of the gate)', () => {
  const viaProxy = {
    socket: { remoteAddress: '10.0.0.1' },
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'a' },
  };

  test('reads x-forwarded-for only behind a trusted proxy', () => {
    expect(resolveClientIp(viaProxy, new Set(['10.0.0.1']))).toBe('203.0.113.9');
    expect(resolveClientIp(viaProxy, new Set())).toBe('10.0.0.1');
  });

  test('ignores the User-Agent: one IP, one key', () => {
    const other = { ...viaProxy, headers: { ...viaProxy.headers, 'user-agent': 'b' } };
    expect(resolveClientIp(other, new Set())).toBe(resolveClientIp(viaProxy, new Set()));
  });
});
