/**
 * Tests for the JSON scalar of the executable schema.
 *
 * Validates that it is a real GraphQLScalarType carrying the description of the
 * SDL, that it passes values through unchanged and that it reads inline
 * literals (objects, lists, null) with the variables of the operation.
 */

import { schema } from '../../../../src/schema/index.js';
import { JSONScalar } from '../../../../src/schema/scalars.js';
import { assertScalarType, parseValue as parseGraphQLValue } from 'graphql';
import type { ValueNode } from 'graphql';

// Lecture d'un littéral GraphQL isolé
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const literal = (source: string): ValueNode => parseGraphQLValue(source) as any;

describe('JSON scalar', () => {
  /**
   * The schema exposes the scalar implementation, not the default pass-through one:
   * an inline object literal only parses through it.
   */
  test('is registered on the executable schema', () => {
    const type = assertScalarType(schema.getType('JSON'));
    expect(type.parseLiteral(literal('{k: [1]}'), {})).toEqual({ k: [1] });
    expect(type.parseValue({ k: [1] })).toEqual({ k: [1] });
  });

  /**
   * The description of the SDL (the documented serialization contract) survives.
   */
  test('keeps the description of the SDL', () => {
    const type = assertScalarType(schema.getType('JSON'));
    expect(type.description).toContain('Custom scalar type for JSON values');
  });

  /**
   * Output and variable values are not altered.
   */
  test('passes serialized and variable values through', () => {
    const value = { a: 1, b: ['x', null, true], c: '9007199254740993' };
    expect(JSONScalar.serialize(value)).toBe(value);
    expect(JSONScalar.parseValue(value)).toBe(value);
    expect(JSONScalar.serialize(null)).toBeNull();
  });

  /**
   * Inline literals are read as plain JSON, variables substituted.
   */
  test('parses inline literals, substituting variables', () => {
    expect(JSONScalar.parseLiteral(literal('{min: 1, max: 9.5}'), {})).toEqual({
      min: 1,
      max: 9.5,
    });
    expect(JSONScalar.parseLiteral(literal('["a", 2, null, false]'), {})).toEqual([
      'a',
      2,
      null,
      false,
    ]);
    expect(JSONScalar.parseLiteral(literal('"2024-03-05"'), {})).toBe('2024-03-05');
    expect(JSONScalar.parseLiteral(literal('{min: $lo}'), { lo: 3 })).toEqual({ min: 3 });
  });
});
