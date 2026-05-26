/**
 * Integration tests for cross-database GraphQL resolvers.
 *
 * Covers the CROSS_DATABASE_DISABLED guard, input validation, and
 * (when ALLOW_CROSS_DATABASE_QUERIES=true) functional tests for
 * compareFacts, compareAggregatedFacts, and crossDatabaseSelectOptions.
 *
 * Run with: ALLOW_CROSS_DATABASE_QUERIES=true npm test
 */

import { ApolloServer } from '@apollo/server';
import { ensureSetup, getServer, execute } from './helpers.js';
import { databaseManager } from '../../../../src/db/index.js';

// ─── Configuration des tests cross-database ───────────────────────────────────

// Activation conditionnelle des tests nécessitant la fonctionnalité cross-database
const CROSS_DB_ENABLED = process.env.ALLOW_CROSS_DATABASE_QUERIES === 'true';

// ─── État partagé ─────────────────────────────────────────────────────────────

// Serveur Apollo et liste des bases disponibles, initialisés avant les tests
let server: ApolloServer;
let availableDatabases: string[] = [];

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();

  // Récupération des identifiants de bases disponibles pour les tests conditionnels
  const result = await execute(server, {
    query: `query { getCatalogs { id } }`,
  });
  if (!result.errors) {
    availableDatabases = (result.data!.getCatalogs as Array<{ id: string }>).map((d) => d.id);
  }
}, 60000);

// ─── Tests toujours actifs — désactivation de la fonctionnalité ───────────────

describe('cross-database feature disabled (CROSS_DATABASE_DISABLED)', () => {
  // Sauvegarde de la méthode originale pour restauration après chaque test
  let savedMethod: () => boolean;

  beforeEach(() => {
    savedMethod = databaseManager.isCrossCatalogAllowed.bind(databaseManager);
    // Remplacement temporaire de la méthode pour simuler la désactivation
    databaseManager.isCrossCatalogAllowed = () => false;
  });

  afterEach(() => {
    // Restauration de la méthode d'origine
    databaseManager.isCrossCatalogAllowed = savedMethod;
  });

  test('compareFacts raises CROSS_DATABASE_DISABLED', async () => {
    const query = `
      query {
        compareFacts(catalogA: "a", catalogB: "b", joinFields: ["country"], limit: 5) {
          data { key valueA valueB }
          total
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
    expect(result.errors![0].extensions?.['code']).toBe('CROSS_DATABASE_DISABLED');
  });

  test('compareAggregatedFacts raises CROSS_DATABASE_DISABLED', async () => {
    const query = `
      query {
        compareAggregatedFacts(
          catalogA: "a"
          catalogB: "b"
          groupBy: "country"
          aggregation: SUM
          limit: 5
        ) { data { key valueA valueB } total }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
    expect(result.errors![0].extensions?.['code']).toBe('CROSS_DATABASE_DISABLED');
  });

  test('crossDatabaseSelectOptions raises CROSS_DATABASE_DISABLED', async () => {
    const query = `
      query {
        crossDatabaseSelectOptions(fieldName: "country", catalogs: ["a", "b"], limit: 10) {
          value
          label
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
    expect(result.errors![0].extensions?.['code']).toBe('CROSS_DATABASE_DISABLED');
  });

  test('compareFacts accepte les arguments schemaA et schemaB', async () => {
    const query = `
      query {
        compareFacts(
          catalogA: "a"
          catalogB: "a"
          schemaA: "schema_a"
          schemaB: "schema_b"
          joinFields: ["country"]
          limit: 5
        ) { data { key } total }
      }
    `;
    const result = await execute(server, { query });

    // L'erreur doit être CROSS_DATABASE_DISABLED (args reconnus par GraphQL)
    // et non une erreur de validation "Unknown argument"
    expect(result.errors).toBeDefined();
    expect(result.errors![0].extensions?.['code']).toBe('CROSS_DATABASE_DISABLED');
  });
});

// ─── Tests de validation des entrées — fonctionnalité activée ─────────────────

describe('input validation (feature enabled, invalid inputs)', () => {
  test('compareFacts rejects empty joinFields', async () => {
    if (!databaseManager.isCrossCatalogAllowed()) return;

    const [dbA, dbB] = availableDatabases;
    if (!dbA || !dbB) return;

    const query = `
      query {
        compareFacts(catalogA: "${dbA}", catalogB: "${dbB}", joinFields: [], limit: 5) {
          data { key }
          total
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
  });

  test('compareAggregatedFacts rejects unknown database', async () => {
    if (!databaseManager.isCrossCatalogAllowed()) return;

    const [dbA] = availableDatabases;
    if (!dbA) return;

    const query = `
      query {
        compareAggregatedFacts(
          catalogA: "${dbA}"
          catalogB: "nonexistent_xyz"
          groupBy: "country"
          aggregation: SUM
          limit: 5
        ) { data { key } total }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
  });

  test('crossDatabaseSelectOptions requires at least two databases', async () => {
    if (!databaseManager.isCrossCatalogAllowed()) return;

    const [dbA] = availableDatabases;
    if (!dbA) return;

    const query = `
      query {
        crossDatabaseSelectOptions(fieldName: "country", catalogs: ["${dbA}"], limit: 10) {
          value label
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
  });
});

// ─── Tests activés uniquement si ALLOW_CROSS_DATABASE_QUERIES=true ────────────

// Sélection du runner de suite selon l'activation de la fonctionnalité
const describeCrossDB = CROSS_DB_ENABLED ? describe : describe.skip;

describeCrossDB('crossDatabaseSelectOptions (enabled)', () => {
  test('returns common values across two databases', async () => {
    const [dbA, dbB] = availableDatabases;
    if (!dbA || !dbB) {
      console.warn('Skipping: fewer than 2 databases available');
      return;
    }

    const query = `
      query {
        crossDatabaseSelectOptions(
          fieldName: "country"
          catalogs: ["${dbA}", "${dbB}"]
          limit: 50
        ) { value label }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(Array.isArray(result.data!.crossDatabaseSelectOptions)).toBe(true);
  });
});

describeCrossDB('compareFacts (enabled)', () => {
  test('returns PaginatedComparedFacts with correct structure', async () => {
    const [dbA, dbB] = availableDatabases;
    if (!dbA || !dbB) return;

    const query = `
      query {
        compareFacts(
          catalogA: "${dbA}"
          catalogB: "${dbB}"
          joinFields: ["country"]
          limit: 10
          offset: 0
        ) {
          data { key valueA valueB delta deltaPercent }
          total
          hasNextPage
          currentPage
          totalPages
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const r = result.data!.compareFacts as {
      total: number;
      data: Array<{ key: string; valueA: number | null; valueB: number | null; delta: number }>;
    };
    expect(typeof r.total).toBe('number');

    // Vérification de la cohérence du delta (valueB - valueA)
    if (r.data.length > 0) {
      const row = r.data[0];
      expect(row).toHaveProperty('key');
      expect(row).toHaveProperty('valueA');
      expect(row).toHaveProperty('valueB');
      expect(row).toHaveProperty('delta');
      if (row.valueA !== null && row.valueB !== null) {
        expect(Math.abs(row.delta - (row.valueB - row.valueA))).toBeLessThan(0.0001);
      }
    }
  });

  test('sort by delta DESC produces descending delta values', async () => {
    const [dbA, dbB] = availableDatabases;
    if (!dbA || !dbB) return;

    const query = `
      query {
        compareFacts(
          catalogA: "${dbA}"
          catalogB: "${dbB}"
          joinFields: ["country"]
          limit: 20
          offset: 0
          sort: [{ field: "delta", order: DESC }]
        ) { data { key delta } total }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Vérification de l'ordre décroissant des deltas non nuls
    const deltas = (result.data!.compareFacts as { data: Array<{ delta: number | null }> }).data
      .map((d) => d.delta)
      .filter((d): d is number => d !== null);
    for (let i = 1; i < deltas.length; i++) {
      expect(deltas[i]).toBeLessThanOrEqual(deltas[i - 1]);
    }
  });

  test('multi-field join key is concatenated with ::', async () => {
    const [dbA, dbB] = availableDatabases;
    if (!dbA || !dbB) return;

    const query = `
      query {
        compareFacts(
          catalogA: "${dbA}"
          catalogB: "${dbB}"
          joinFields: ["country", "indicator"]
          limit: 10
          offset: 0
        ) { data { key valueA valueB } total }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Vérification du séparateur :: pour les clés multi-champs
    const rows = (result.data!.compareFacts as { data: Array<{ key: string }> }).data;
    if (rows.length > 0) {
      expect(rows[0].key).toContain('::');
    }
  });
});

describeCrossDB('compareAggregatedFacts (enabled)', () => {
  test('returns aggregated comparison with correct structure', async () => {
    const [dbA, dbB] = availableDatabases;
    if (!dbA || !dbB) return;

    const query = `
      query {
        compareAggregatedFacts(
          catalogA: "${dbA}"
          catalogB: "${dbB}"
          groupBy: "country"
          aggregation: SUM
          limit: 10
          offset: 0
        ) {
          data { key valueA valueB delta deltaPercent }
          total
          hasNextPage
          currentPage
          totalPages
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const r = result.data!.compareAggregatedFacts as {
      total: number;
      data: Array<{ key: string; valueA: unknown; valueB: unknown }>;
    };
    expect(typeof r.total).toBe('number');
    if (r.data.length > 0) {
      expect(r.data[0]).toHaveProperty('key');
      expect(r.data[0]).toHaveProperty('valueA');
      expect(r.data[0]).toHaveProperty('valueB');
    }
  });

  test('AVG aggregation groupBy indicator', async () => {
    const [dbA, dbB] = availableDatabases;
    if (!dbA || !dbB) return;

    const query = `
      query {
        compareAggregatedFacts(
          catalogA: "${dbA}"
          catalogB: "${dbB}"
          groupBy: "indicator"
          aggregation: AVG
          limit: 10
          offset: 0
        ) { data { key valueA valueB delta } total }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(typeof (result.data!.compareAggregatedFacts as { total: number }).total).toBe('number');
  });
});
