/**
 * Unit tests of the trusted-proxy list parser (src/security/trusted-proxies.ts).
 *
 * Covers every accepted shape of TRUSTED_PROXIES (YAML list, JSON-array string
 * from an environment override, comma-separated string), CIDR blocks, named
 * ranges and the fail-fast rejection of invalid entries.
 */

import { describe, test, expect } from '@jest/globals';
import { parseTrustedProxies } from '../../../src/security/trusted-proxies.js';

describe('parseTrustedProxies', () => {
  describe('accepted shapes', () => {
    test('parses the JSON-array string of an environment override', () => {
      expect(parseTrustedProxies('["10.0.0.0/8"]')).toEqual(['10.0.0.0/8']);
      expect(parseTrustedProxies(' ["10.0.0.1", "127.0.0.1"] ')).toEqual(['10.0.0.1', '127.0.0.1']);
    });

    test('keeps a YAML list, trimming its entries', () => {
      expect(parseTrustedProxies(['10.0.0.1', ' 192.168.0.0/16 '])).toEqual([
        '10.0.0.1',
        '192.168.0.0/16',
      ]);
    });

    test('splits a comma-separated string', () => {
      expect(parseTrustedProxies('10.0.0.0/8, 127.0.0.1')).toEqual(['10.0.0.0/8', '127.0.0.1']);
    });

    test('accepts IPv4 and IPv6 CIDR blocks at their bounds', () => {
      expect(parseTrustedProxies(['0.0.0.0/0', '10.42.0.7/32', 'fc00::/7', '::1/128'])).toEqual([
        '0.0.0.0/0',
        '10.42.0.7/32',
        'fc00::/7',
        '::1/128',
      ]);
    });

    test('accepts the proxy-addr named ranges', () => {
      expect(parseTrustedProxies(['loopback', 'linklocal', 'uniquelocal'])).toEqual([
        'loopback',
        'linklocal',
        'uniquelocal',
      ]);
    });

    test("maps '*' to true (trust every hop)", () => {
      expect(parseTrustedProxies(['*'])).toBe(true);
      expect(parseTrustedProxies('["10.0.0.1", "*"]')).toBe(true);
    });

    test('returns an empty list when nothing is configured', () => {
      expect(parseTrustedProxies(undefined)).toEqual([]);
      expect(parseTrustedProxies(null)).toEqual([]);
      expect(parseTrustedProxies('')).toEqual([]);
      expect(parseTrustedProxies('[]')).toEqual([]);
      expect(parseTrustedProxies([])).toEqual([]);
    });
  });

  describe('invalid input', () => {
    test('throws on malformed JSON', () => {
      expect(() => parseTrustedProxies('["10.0.0.0/8"')).toThrow(/invalid JSON/);
    });

    test('throws on an out-of-range prefix', () => {
      expect(() => parseTrustedProxies(['10.0.0.0/33'])).toThrow(/10\.0\.0\.0\/33/);
      expect(() => parseTrustedProxies(['::1/129'])).toThrow(/invalid entry/);
      expect(() => parseTrustedProxies(['10.0.0.0/'])).toThrow(/invalid entry/);
      expect(() => parseTrustedProxies(['10.0.0.0/8/8'])).toThrow(/invalid entry/);
    });

    test('throws on something that is not an IP', () => {
      expect(() => parseTrustedProxies(['not-an-ip'])).toThrow(/not-an-ip/);
      expect(() => parseTrustedProxies('10.0.0.1, ingress.local')).toThrow(/ingress\.local/);
      expect(() => parseTrustedProxies(['999.0.0.1'])).toThrow(/invalid entry/);
    });

    test('throws on a non-string item', () => {
      expect(() => parseTrustedProxies([10])).toThrow(/invalid entry 10/);
      expect(() => parseTrustedProxies('[null]')).toThrow(/invalid entry null/);
    });

    test('throws on a value that is not a list', () => {
      expect(() => parseTrustedProxies({ proxy: '10.0.0.1' })).toThrow(/expected a list/);
      expect(() => parseTrustedProxies(42)).toThrow(/expected a list/);
    });
  });
});
