/**
 * Unit tests for cache-keys.ts (src/cache/cache-keys.ts).
 *
 * Verifies the versioned namespace of Redis keys: the served data version sits
 * next to the schema, every side of a composite (cross-database) key is
 * versioned, and a version change always yields a different key.
 */

import { buildCacheKey, versionedSegment } from '../../../src/cache/cache-keys.js';

// Versions servies simulées, par "catalogue.schéma"
const versions: Record<string, string> = {
  'default.main': '1767225600123456',
  'default.trade': '1767225600999999',
  'macroeconomics.trade': '1769990400000000',
};
const versionOf = (catalog: string, schema: string): string =>
  versions[`${catalog}.${schema}`] ?? 'none';

describe('versionedSegment', () => {
  test('appends the served data version to the schema', () => {
    expect(versionedSegment('default', 'main', versionOf)).toBe('default:main@1767225600123456');
  });

  test('uses "none" for a schema without a readable marker', () => {
    expect(versionedSegment('default', 'unknown', versionOf)).toBe('default:unknown@none');
  });

  test('versions every side of a composite namespace', () => {
    expect(versionedSegment('default+macroeconomics', 'trade+trade', versionOf)).toBe(
      'default+macroeconomics:trade@1767225600999999+trade@1769990400000000',
    );
  });

  test('a composite namespace on one catalog reads each schema of that catalog', () => {
    expect(versionedSegment('default', 'main+trade', versionOf)).toBe(
      'default:main@1767225600123456+trade@1767225600999999',
    );
  });
});

describe('buildCacheKey', () => {
  test('builds <prefix>:<catalog>:<schema>@<version>:<variant><hash>', () => {
    expect(
      buildCacheKey(
        { prefix: 'facts', catalog: 'default', schema: 'main', variant: 'with-count', hash: 'abc' },
        versionOf,
      ),
    ).toBe('facts:default:main@1767225600123456:with-count:abc');
  });

  test('omits the variant segment when there is none', () => {
    expect(
      buildCacheKey(
        { prefix: 'metadata', catalog: 'default', schema: 'main', hash: 'abc' },
        () => '7',
      ),
    ).toBe('metadata:default:main@7:abc');
  });

  test('a new data version moves the key, the old one is left unreachable', () => {
    const parts = { prefix: 'facts', catalog: 'default', schema: 'main', hash: 'abc' };
    const before = buildCacheKey(parts, () => '1');
    const after = buildCacheKey(parts, () => '2');
    expect(after).not.toBe(before);
  });

  test('an update of one side of a composite key moves it', () => {
    const parts = {
      prefix: 'cross-database',
      catalog: 'default+macroeconomics',
      schema: 'trade+trade',
      hash: 'abc',
    };
    const before = buildCacheKey(parts, versionOf);
    const after = buildCacheKey(parts, (c, s) =>
      c === 'macroeconomics' ? 'newer' : versionOf(c, s),
    );
    expect(after).not.toBe(before);
  });
});
