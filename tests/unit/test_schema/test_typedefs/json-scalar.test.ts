/**
 * Tests for the JSON scalar of the executable schema.
 *
 * Validates that it is a real GraphQLScalarType carrying the description of the
 * SDL, that it passes values through unchanged and that it reads inline
 * literals (objects, lists, null) with the variables of the operation.
 */

import { schema } from '../../../../src/schema/index.js';
import { JSONScalar } from '../../../../src/schema/scalars.js';
import {
  assertScalarType,
  getVariableValues,
  parse,
  parseConstValue,
  parseValue as parseGraphQLValue,
  replaceVariables,
} from 'graphql';
import type { ConstValueNode, OperationDefinitionNode } from 'graphql';

// Lecture d'un littéral GraphQL constant isolé
const literal = (source: string): ConstValueNode => parseConstValue(source);

describe('JSON scalar', () => {
  /**
   * The schema exposes the scalar implementation, not the default pass-through one:
   * an inline object literal only parses through it.
   */
  test('is registered on the executable schema', () => {
    const type = assertScalarType(schema.getType('JSON'));
    expect(type.coerceInputLiteral?.(literal('{k: [1]}'))).toEqual({ k: [1] });
    expect(type.coerceInputValue({ k: [1] })).toEqual({ k: [1] });
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
    expect(JSONScalar.coerceOutputValue(value)).toBe(value);
    expect(JSONScalar.coerceInputValue(value)).toBe(value);
    expect(JSONScalar.coerceOutputValue(null)).toBeNull();
  });

  /**
   * Inline literals are read as plain JSON.
   */
  test('parses inline literals', () => {
    expect(JSONScalar.coerceInputLiteral?.(literal('{min: 1, max: 9.5}'))).toEqual({
      min: 1,
      max: 9.5,
    });
    expect(JSONScalar.coerceInputLiteral?.(literal('["a", 2, null, false]'))).toEqual([
      'a',
      2,
      null,
      false,
    ]);
    expect(JSONScalar.coerceInputLiteral?.(literal('"2024-03-05"'))).toBe('2024-03-05');
  });

  /**
   * Variables nested in a literal are substituted by GraphQL.js (replaceVariables)
   * before the scalar reads it.
   */
  test('reads literals once their variables are substituted', () => {
    const operation = parse('query ($lo: Int) { __typename }')
      .definitions[0] as OperationDefinitionNode;
    const { variableValues } = getVariableValues(schema, operation.variableDefinitions ?? [], {
      lo: 3,
    });
    const node = replaceVariables(parseGraphQLValue('{min: $lo}'), variableValues);
    expect(JSONScalar.coerceInputLiteral?.(node)).toEqual({ min: 3 });
  });

  /**
   * The deprecated hooks (removed in graphql 18) stay derived from the new ones.
   */
  test('keeps the deprecated hooks working', () => {
    expect(JSONScalar.serialize({ k: 1 })).toEqual({ k: 1 });
    expect(JSONScalar.parseValue({ k: 1 })).toEqual({ k: 1 });
    expect(JSONScalar.parseLiteral(parseGraphQLValue('{min: $lo}'), { lo: 3 })).toEqual({
      min: 3,
    });
  });
});
