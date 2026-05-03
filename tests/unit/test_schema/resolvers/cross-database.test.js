import { ensureSetup, getServer, execute } from './helpers.js';
import { databaseManager } from '../../../../src/db/index.js';

// Cross-database integration tests require ALLOW_CROSS_DATABASE_QUERIES=true AND
// at least two databases with actual data. Run with:
//   ALLOW_CROSS_DATABASE_QUERIES=true npm test
const CROSS_DB_ENABLED = process.env.ALLOW_CROSS_DATABASE_QUERIES === 'true';

let server;
let availableDatabases = [];

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();

  const result = await execute(server, {
    query: `query { getDatabases { id dimensionNames } }`
  });
  if (!result.errors) {
    availableDatabases = result.data.getDatabases.map(d => d.id);
  }
}, 60000);

// ─── Always-on tests ──────────────────────────────────────────────────────────

describe('cross-database feature disabled (CROSS_DATABASE_DISABLED)', () => {
  let savedMethod;

  beforeEach(() => {
    savedMethod = databaseManager.isCrossDatabaseAllowed.bind(databaseManager);
    databaseManager.isCrossDatabaseAllowed = () => false;
  });

  afterEach(() => {
    databaseManager.isCrossDatabaseAllowed = savedMethod;
  });

  test('compareFacts raises CROSS_DATABASE_DISABLED', async () => {
    const query = `
      query {
        compareFacts(databaseA: "a", databaseB: "b", joinFields: ["country"], limit: 5) {
          data { key valueA valueB }
          total
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
    expect(result.errors[0].extensions?.code).toBe('CROSS_DATABASE_DISABLED');
  });

  test('compareAggregatedFacts raises CROSS_DATABASE_DISABLED', async () => {
    const query = `
      query {
        compareAggregatedFacts(
          databaseA: "a"
          databaseB: "b"
          groupBy: "country"
          aggregation: SUM
          limit: 5
        ) { data { key valueA valueB } total }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
    expect(result.errors[0].extensions?.code).toBe('CROSS_DATABASE_DISABLED');
  });

  test('crossDatabaseSelectOptions raises CROSS_DATABASE_DISABLED', async () => {
    const query = `
      query {
        crossDatabaseSelectOptions(fieldName: "country", databases: ["a", "b"], limit: 10) {
          value
          label
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
    expect(result.errors[0].extensions?.code).toBe('CROSS_DATABASE_DISABLED');
  });
});

describe('input validation (feature enabled, invalid inputs)', () => {
  test('compareFacts rejects empty joinFields', async () => {
    if (!databaseManager.isCrossDatabaseAllowed()) return;

    const [dbA, dbB] = availableDatabases;
    if (!dbA || !dbB) return;

    const query = `
      query {
        compareFacts(databaseA: "${dbA}", databaseB: "${dbB}", joinFields: [], limit: 5) {
          data { key }
          total
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
  });

  test('compareAggregatedFacts rejects unknown database', async () => {
    if (!databaseManager.isCrossDatabaseAllowed()) return;

    const [dbA] = availableDatabases;
    if (!dbA) return;

    const query = `
      query {
        compareAggregatedFacts(
          databaseA: "${dbA}"
          databaseB: "nonexistent_xyz"
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
    if (!databaseManager.isCrossDatabaseAllowed()) return;

    const [dbA] = availableDatabases;
    if (!dbA) return;

    const query = `
      query {
        crossDatabaseSelectOptions(fieldName: "country", databases: ["${dbA}"], limit: 10) {
          value label
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
  });
});

// ─── Enabled-only tests ───────────────────────────────────────────────────────
// Run with: ALLOW_CROSS_DATABASE_QUERIES=true npm test

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
          databases: ["${dbA}", "${dbB}"]
          limit: 50
        ) { value label }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(Array.isArray(result.data.crossDatabaseSelectOptions)).toBe(true);
  });
});

describeCrossDB('compareFacts (enabled)', () => {
  test('returns PaginatedComparedFacts with correct structure', async () => {
    const [dbA, dbB] = availableDatabases;
    if (!dbA || !dbB) return;

    const query = `
      query {
        compareFacts(
          databaseA: "${dbA}"
          databaseB: "${dbB}"
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
    const r = result.data.compareFacts;
    expect(typeof r.total).toBe('number');
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
          databaseA: "${dbA}"
          databaseB: "${dbB}"
          joinFields: ["country"]
          limit: 20
          offset: 0
          sort: [{ field: "delta", order: DESC }]
        ) { data { key delta } total }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const deltas = result.data.compareFacts.data.map(d => d.delta).filter(d => d !== null);
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
          databaseA: "${dbA}"
          databaseB: "${dbB}"
          joinFields: ["country", "indicator"]
          limit: 10
          offset: 0
        ) { data { key valueA valueB } total }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    if (result.data.compareFacts.data.length > 0) {
      expect(result.data.compareFacts.data[0].key).toContain('::');
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
          databaseA: "${dbA}"
          databaseB: "${dbB}"
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
    const r = result.data.compareAggregatedFacts;
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
          databaseA: "${dbA}"
          databaseB: "${dbB}"
          groupBy: "indicator"
          aggregation: AVG
          limit: 10
          offset: 0
        ) { data { key valueA valueB delta } total }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(typeof result.data.compareAggregatedFacts.total).toBe('number');
  });
});
