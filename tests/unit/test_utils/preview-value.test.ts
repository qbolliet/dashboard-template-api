/**
 * Unit tests for previewValue (src/utils/preview-value.ts).
 *
 * Client values echoed in error messages are unbounded (they are bound
 * parameters): the helper must keep every message short.
 */

import { previewValue, DEFAULT_PREVIEW_LENGTH } from '../../../src/utils/preview-value.js';

describe('previewValue', () => {
  test('renders a short string as quoted JSON', () => {
    expect(previewValue('France')).toBe('"France"');
  });

  test('renders numbers, booleans, null and objects as compact JSON', () => {
    expect(previewValue(42)).toBe('42');
    expect(previewValue(false)).toBe('false');
    expect(previewValue(null)).toBe('null');
    expect(previewValue({ a: [1, 2] })).toBe('{"a":[1,2]}');
  });

  test('renders undefined and functions without throwing', () => {
    expect(previewValue(undefined)).toBe('undefined');
    expect(previewValue(() => 1)).toContain('=>');
  });

  test('falls back to String() for a BigInt or a circular structure', () => {
    expect(previewValue(10n)).toBe('10');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(previewValue(loop)).toBe('[object Object]');
  });

  test('keeps a value of exactly the maximum length untouched', () => {
    const text = 'a'.repeat(DEFAULT_PREVIEW_LENGTH - 2);
    expect(previewValue(text)).toBe(`"${text}"`);
  });

  test('truncates a long value with an ellipsis', () => {
    const preview = previewValue('x'.repeat(50_000));
    expect(preview).toHaveLength(DEFAULT_PREVIEW_LENGTH + 1);
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.startsWith('"xxx')).toBe(true);
  });

  test('honours an explicit maximum length', () => {
    expect(previewValue('abcdefghij', 5)).toBe('"abcd…');
  });

  test('truncates a large object', () => {
    expect(previewValue({ list: Array(10_000).fill(1) }, 20)).toHaveLength(21);
  });
});
