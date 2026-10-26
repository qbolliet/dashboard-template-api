/**
 * Tests for the GraphQL.js tracing (node:diagnostics_channel, graphql 17).
 *
 * Runs the real parse / validate / execute of GraphQL.js on a small schema and
 * checks the measures read on its tracing channels: counts, errors, sync and
 * async calls, custom resolvers only, and unsubscription.
 */

import { describe, test, expect, afterEach } from '@jest/globals';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { execute, parse, validate } from 'graphql';
import type { GraphQLSchema } from 'graphql';
import { GraphQLTracing } from '../../../src/utils/graphql-tracing.js';

// Schéma minimal : un resolver synchrone, un asynchrone, un en erreur, un champ
// lu par le resolver par défaut (Item.id)
const schema: GraphQLSchema = makeExecutableSchema({
  typeDefs: `
    type Item { id: ID! }
    type Query { sync: Int, slow: Int, broken: Int, item: Item }
  `,
  resolvers: {
    Query: {
      sync: (): number => 1,
      slow: async (): Promise<number> => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 2;
      },
      broken: (): never => {
        throw new Error('boom');
      },
      item: (): { id: string } => ({ id: 'a' }),
    },
  },
});

/**
 * Runs an operation through the three phases, as Apollo Server does.
 *
 * @param source - Operation source.
 */
async function run(source: string): Promise<void> {
  const document = parse(source);
  if (validate(schema, document).length === 0) {
    await execute({ schema, document });
  }
}

describe('GraphQLTracing', () => {
  let tracing: GraphQLTracing | undefined;

  afterEach(() => {
    tracing?.disable();
    tracing = undefined;
  });

  test('counts the parse, validate and execute phases with their durations', async () => {
    tracing = new GraphQLTracing();
    tracing.enable();

    await run('{ sync slow }');
    await run('{ sync }');

    const { phases, resolvers } = tracing.snapshot();
    for (const phase of ['parse', 'validate', 'execute'] as const) {
      expect(phases[phase].count).toBe(2);
      expect(phases[phase].errors).toBe(0);
      expect(phases[phase].samples).toBe(2);
    }
    // Exécution asynchrone mesurée jusqu'à sa résolution (asyncEnd)
    expect(phases.execute.p95Ms).toBeGreaterThanOrEqual(4);
    // Resolvers non tracés par défaut
    expect(resolvers).toBeUndefined();
  });

  test('counts validation and execution errors', async () => {
    tracing = new GraphQLTracing();
    tracing.enable();

    await run('{ unknownField }');
    await run('{ broken }');

    const { phases } = tracing.snapshot();
    expect(phases.validate).toMatchObject({ count: 2, errors: 1 });
    expect(phases.execute).toMatchObject({ count: 1, errors: 1 });
  });

  test('a parse error is counted', () => {
    tracing = new GraphQLTracing();
    tracing.enable();

    expect(() => parse('{ sync')).toThrow();

    expect(tracing.snapshot().phases.parse).toMatchObject({ count: 1, errors: 1 });
  });

  test('traces custom resolvers only, slowest first', async () => {
    tracing = new GraphQLTracing({ resolvers: true });
    tracing.enable();

    await run('{ sync slow broken item { id } }');

    const resolvers = tracing.snapshot().resolvers ?? [];
    const fields = resolvers.map((stats) => stats.field);
    // Item.id passe par le resolver par défaut : ignoré
    expect(fields).toEqual(expect.arrayContaining(['Query.sync', 'Query.slow', 'Query.broken']));
    expect(fields).not.toContain('Item.id');
    expect(fields[0]).toBe('Query.slow');
    expect(resolvers.find((stats) => stats.field === 'Query.broken')?.errors).toBe(1);
  });

  test('stops measuring once disabled, and enable is idempotent', async () => {
    tracing = new GraphQLTracing();
    tracing.enable();
    tracing.enable();
    await run('{ sync }');
    tracing.disable();
    await run('{ sync }');

    expect(tracing.enabled).toBe(false);
    expect(tracing.snapshot().phases.execute.count).toBe(1);
  });
});
