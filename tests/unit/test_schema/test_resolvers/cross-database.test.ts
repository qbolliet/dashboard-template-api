/**
 * Integration tests for cross-database GraphQL resolvers.
 *
 * Covers the CROSS_DATABASE_DISABLED guard, input validation, and
 * (when ALLOW_CROSS_CATALOG_QUERIES=true, which tests/setup/setup-env.ts
 * sets) functional tests for compareFacts, compareAggregatedFacts, and
 * crossDatabaseSelectOptions — all joining directly on the labels carried
 * by the columns of the two test catalogs.
 */

import { ApolloServer } from '@apollo/server';
import { ensureSetup, getServer, execute } from './helpers.js';
import { databaseManager } from '../../../../src/db/index.js';

// ─── Configuration des tests cross-database ───────────────────────────────────

// Activation conditionnelle des tests nécessitant la fonctionnalité cross-catalogue.
// Le drapeau est ALLOW_CROSS_CATALOG_QUERIES (cf. config/database.yaml) : l'ancien
// nom ALLOW_CROSS_DATABASE_QUERIES désactivait silencieusement toute la suite.
const CROSS_DB_ENABLED = process.env.ALLOW_CROSS_CATALOG_QUERIES === 'true';

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
          groupBy: [{ field: "country" }]
          aggregates: [{ measure: "value", aggregation: SUM }]
          limit: 5
        ) { data total }
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
          groupBy: [{ field: "country" }]
          aggregates: [{ measure: "value" }]
          limit: 5
        ) { data total }
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
  test('returns AggregateComparison with correct structure', async () => {
    const [dbA, dbB] = availableDatabases;
    if (!dbA || !dbB) return;

    const query = `
      query {
        compareAggregatedFacts(
          catalogA: "${dbA}"
          catalogB: "${dbB}"
          groupBy: [{ field: "country" }]
          aggregates: [{ measure: "value", aggregation: SUM }]
          limit: 10
          offset: 0
        ) {
          groupBy { name labelColumn }
          aggregates { alias measure aggregation sqlType }
          columns
          data
          total
          hasNextPage
          generatedAt
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const r = result.data!.compareAggregatedFacts as {
      groupBy: Array<{ name: string; labelColumn: string | null }>;
      aggregates: Array<{ alias: string; measure: string; aggregation: string; sqlType: string }>;
      columns: string[];
      total: number;
    };
    expect(typeof r.total).toBe('number');
    expect(r.groupBy).toEqual([{ name: 'country', labelColumn: null }]);
    expect(r.aggregates).toEqual([
      { alias: 'value_sum', measure: 'value', aggregation: 'SUM', sqlType: 'DOUBLE' },
    ]);
    expect(r.columns).toEqual([
      'country',
      'value_sum_a',
      'value_sum_b',
      'value_sum_delta',
      'value_sum_delta_pct',
    ]);
  });

  test('AVG aggregation groupBy indicator', async () => {
    const [dbA, dbB] = availableDatabases;
    if (!dbA || !dbB) return;

    const query = `
      query {
        compareAggregatedFacts(
          catalogA: "${dbA}"
          catalogB: "${dbB}"
          groupBy: [{ field: "indicator" }]
          aggregates: [{ measure: "value", aggregation: AVG }]
          limit: 10
          offset: 0
        ) { data total }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(typeof (result.data!.compareAggregatedFacts as { total: number }).total).toBe('number');
  });
});

describeCrossDB('comparaisons sur les libellés des catalogues de test', () => {
  /**
   * Aggregates the `value` measure of default and macroeconomics by column.
   *
   * Aggregating first keeps the comparison to one row per label, so the
   * assertions below never depend on where the pagination window falls.
   *
   * @param groupBy - Column used as the grouping key.
   * @returns The rows, reduced to key, valueA, valueB, delta and deltaPercent.
   */
  // Comparaison default ↔ macroeconomics, agrégée par libellé
  async function compareAggregatedOn(groupBy: string) {
    const result = await execute(server, {
      query: `
        query {
          compareAggregatedFacts(
            catalogA: "default"
            catalogB: "macroeconomics"
            groupBy: [{ field: "${groupBy}" }]
            aggregates: [{ measure: "value", aggregation: SUM }]
            limit: 100
            offset: 0
          ) { data total }
        }
      `,
    });
    expect(result.errors).toBeUndefined();
    const { data } = result.data!.compareAggregatedFacts as {
      data: Array<Record<string, number | string | null>>;
    };
    return data.map((row) => ({
      key: row[groupBy] as string,
      valueA: row.value_sum_a as number | null,
      valueB: row.value_sum_b as number | null,
      delta: row.value_sum_delta as number | null,
      deltaPercent: row.value_sum_delta_pct as number | null,
    }));
  }

  test('apparie les libellés communs et écarte les libellés disjoints', async () => {
    const rows = await compareAggregatedOn('country');
    const keys = rows.map((row) => row.key);

    // Libellés présents dans les deux catalogues
    expect(keys).toContain('France');
    expect(keys).toContain('Germany');
    // Libellés propres à un seul catalogue : écartés par la jointure interne
    expect(keys).not.toContain('Portugal');
    expect(keys).not.toContain('Netherlands');
  });

  test('delta vaut valueB - valueA et deltaPercent en découle', async () => {
    const rows = await compareAggregatedOn('country');
    const row = rows.find((r) => r.key === 'France')!;

    expect(row).toBeDefined();
    expect(Math.abs(row.delta! - (row.valueB! - row.valueA!))).toBeLessThan(0.0001);
    const expected = ((row.valueB! - row.valueA!) / row.valueA!) * 100;
    expect(Math.abs(row.deltaPercent! - expected)).toBeLessThan(0.0001);
  });

  test('deltaPercent est nul quand valueA vaut 0 (pas de division par zéro)', async () => {
    const rows = await compareAggregatedOn('country');
    // Zeroland ne porte qu'une ligne par catalogue, à 0 côté default
    const zero = rows.find((row) => row.key === 'Zeroland')!;

    expect(zero).toBeDefined();
    expect(zero.valueA).toBe(0);
    expect(zero.delta).toBe(zero.valueB);
    // CASE WHEN a.value != 0 : la division n'est jamais tentée
    expect(zero.deltaPercent).toBeNull();
  });

  test('compareFacts joint sur les libellés des colonnes-clés', async () => {
    const result = await execute(server, {
      query: `
        query {
          compareFacts(
            catalogA: "default"
            catalogB: "macroeconomics"
            joinFields: ["country", "indicator", "kind", "date"]
            limit: 50
            offset: 0
          ) { data { key valueA valueB delta } total }
        }
      `,
    });

    expect(result.errors).toBeUndefined();
    const rows = (
      result.data!.compareFacts as {
        data: Array<{ key: string; valueA: number | null; valueB: number | null; delta: number }>;
      }
    ).data;
    expect(rows.length).toBeGreaterThan(0);

    // Les quatre colonnes de jointure portent des libellés, concaténés dans la clé
    const disjoint = ['Portugal', 'Netherlands', 'Belgium'];
    for (const row of rows) {
      const parts = row.key.split('::');
      expect(parts).toHaveLength(4);
      // Aucun libellé propre à un seul catalogue ne peut apparaître
      expect(disjoint).not.toContain(parts[0]);
      expect(Math.abs(row.delta - (row.valueB! - row.valueA!))).toBeLessThan(0.0001);
    }
  });

  test('crossDatabaseSelectOptions intersecte les libellés des trois catalogues', async () => {
    const result = await execute(server, {
      query: `
        query {
          crossDatabaseSelectOptions(
            fieldName: "country"
            catalogs: ["default", "macroeconomics", "public_finance"]
            limit: 50
          ) { value label }
        }
      `,
    });

    expect(result.errors).toBeUndefined();
    const opts = result.data!.crossDatabaseSelectOptions as Array<{
      value: string;
      label: string;
    }>;
    const values = opts.map((o) => o.value);
    expect(values).toContain('France');
    // Chaque catalogue a son pays propre : aucun ne survit à l'intersection
    expect(values).not.toContain('Portugal');
    expect(values).not.toContain('Netherlands');
    expect(values).not.toContain('Belgium');
    // label = value partout
    expect(opts.every((o) => o.value === o.label)).toBe(true);
  });
});

// ─── Comparaisons pré-agrégées sur des clés non uniques (trade) ───────────────

/**
 * Runs a reference query on the API pool.
 *
 * @param sql - Query to run.
 * @returns Rows as objects.
 */
// Calcul DuckDB de référence, indépendant du SQL des comparaisons
async function referenceRows(sql: string): Promise<Record<string, unknown>[]> {
  const pool = databaseManager.getPool('default');
  const conn = await pool.acquire();
  try {
    return await conn.all(sql);
  } finally {
    pool.release(conn);
  }
}

/**
 * Aggregates a measure by nc8 on both trade schemas, then pairs them in JS.
 *
 * @param aggregate - SQL aggregate over the fact rows, e.g. `SUM(weight_kg)`.
 * @returns Map nc8 → [value in default.trade, value in macroeconomics.trade],
 *   for the codes present on both sides.
 */
// Référence : agrégat par nc8 de chaque côté, appariement des codes communs
async function referenceByNc8(aggregate: string): Promise<Map<string, [number, number]>> {
  const side = async (catalog: string): Promise<Map<string, number>> => {
    const rows = await referenceRows(
      `SELECT nc8, ${aggregate} AS v FROM "${catalog}"."trade"."fact_table" GROUP BY nc8`,
    );
    return new Map(rows.map((row) => [String(row.nc8), Number(row.v)]));
  };
  const [a, b] = await Promise.all([side('default'), side('macroeconomics')]);
  return new Map(
    [...a.entries()]
      .filter(([code]) => b.has(code))
      .map(([code, value]) => [code, [value, b.get(code)!] as [number, number]]),
  );
}

// Codes nc8 partagés par default.trade (6 lignes par code) et macroeconomics.trade (2 lignes)
const SHARED_NC8 = ['01012100', '02013000', '02013090'];

/** Row of compareFacts as read by these tests. */
interface ComparedRow {
  key: string;
  valueA: number;
  valueB: number;
  delta: number;
  deltaPercent: number | null;
}

/**
 * Runs compareFacts between the two trade schemas.
 *
 * @param args - Extra GraphQL arguments (joinFields, measure, sort, page…).
 * @returns The result, or the errors.
 */
async function compareTrade(args: string) {
  return execute(server, {
    query: `query {
      compareFacts(
        catalogA: "default", schemaA: "trade",
        catalogB: "macroeconomics", schemaB: "trade",
        ${args}
      ) { total hasNextPage measure aggregation data { key valueA valueB delta deltaPercent } }
    }`,
  });
}

describeCrossDB('compareFacts : agrégation par clé avant la jointure', () => {
  test('une ligne par nc8 malgré des clés non uniques, valeurs = référence DuckDB', async () => {
    const result = await compareTrade('joinFields: ["nc8"], limit: 100');
    expect(result.errors).toBeUndefined();
    const r = result.data!.compareFacts as {
      total: number;
      measure: string;
      aggregation: string;
      data: ComparedRow[];
    };

    // value par défaut, agrégée selon son defaultAggregation (SUM)
    expect(r.measure).toBe('value');
    expect(r.aggregation).toBe('SUM');
    expect(r.total).toBe(3);
    expect(r.data.map((row) => row.key)).toEqual(SHARED_NC8);

    const reference = await referenceByNc8('SUM(value)');
    for (const row of r.data) {
      const [a, b] = reference.get(row.key)!;
      expect(row.valueA).toBeCloseTo(a, 6);
      expect(row.valueB).toBeCloseTo(b, 6);
      expect(row.delta).toBeCloseTo(b - a, 6);
      expect(row.deltaPercent).toBeCloseTo(((b - a) / a) * 100, 6);
    }
  });

  test('une mesure autre que value est comparable (weight_kg, AVG explicite)', async () => {
    const result = await compareTrade(
      'joinFields: ["nc8"], measure: "weight_kg", aggregation: AVG, limit: 100',
    );
    expect(result.errors).toBeUndefined();
    const r = result.data!.compareFacts as {
      measure: string;
      aggregation: string;
      data: ComparedRow[];
    };
    expect(r.measure).toBe('weight_kg');
    expect(r.aggregation).toBe('AVG');

    const reference = await referenceByNc8('AVG(weight_kg)');
    expect(r.data).toHaveLength(reference.size);
    for (const row of r.data) {
      const [a, b] = reference.get(row.key)!;
      expect(row.valueA).toBeCloseTo(a, 6);
      expect(row.valueB).toBeCloseTo(b, 6);
    }
  });

  test('plusieurs champs de jointure : une ligne par couple, total exact', async () => {
    const result = await compareTrade('joinFields: ["nc8", "partner_code"], limit: 100');
    expect(result.errors).toBeUndefined();
    const r = result.data!.compareFacts as { total: number; data: ComparedRow[] };

    // 3 codes communs × 2 partenaires communs (macroeconomics n'en a que 2)
    expect(r.total).toBe(6);
    expect(new Set(r.data.map((row) => row.key)).size).toBe(6);
  });

  test('pagination déterministe : pages disjointes qui recouvrent tout, malgré des égalités de tri', async () => {
    // deltaPercent identique pour les couples d'un même code : le départage par les clés fixe l'ordre
    const args =
      'joinFields: ["nc8", "partner_code"], sort: [{ field: "deltaPercent", order: DESC }]';
    const pages: string[] = [];
    for (let offset = 0; offset < 6; offset += 2) {
      const result = await compareTrade(`${args}, limit: 2, offset: ${offset}`);
      expect(result.errors).toBeUndefined();
      pages.push(...(result.data!.compareFacts as { data: ComparedRow[] }).data.map((r) => r.key));
    }
    expect(new Set(pages).size).toBe(6);

    const whole = await compareTrade(`${args}, limit: 6`);
    expect((whole.data!.compareFacts as { data: ComparedRow[] }).data.map((r) => r.key)).toEqual(
      pages,
    );
  });

  test('offset au-delà de MAX_OFFSET → BAD_USER_INPUT', async () => {
    const result = await compareTrade('joinFields: ["nc8"], offset: 10001');
    expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(result.errors![0].message).toMatch(/Offset cannot exceed/);
  });

  test('sans measure ni colonne value → BAD_USER_INPUT', async () => {
    const result = await execute(server, {
      query: `query {
        compareFacts(
          catalogA: "default", schemaA: "geography",
          catalogB: "default", schemaB: "geography",
          joinFields: ["region"]
        ) { total }
      }`,
    });
    expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(result.errors![0].message).toMatch(/no column value .*pass measure/);
  });

  test('mesure à agrégat non numérique → BAD_USER_INPUT', async () => {
    // Texte sans defaultAggregation : aucune agrégation implicite
    const implicit = await compareTrade('joinFields: ["nc8"], measure: "partner_libelle"');
    expect(implicit.errors![0].extensions?.code).toBe('BAD_USER_INPUT');

    const mode = await compareTrade(
      'joinFields: ["nc8"], measure: "partner_libelle", aggregation: MODE',
    );
    expect(mode.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(mode.errors![0].message).toMatch(/is not numeric/);
  });
});

describeCrossDB('compareAggregatedFacts : plusieurs agrégats, forme de getAggregates', () => {
  /**
   * Runs compareAggregatedFacts between the two trade schemas.
   *
   * @param args - GraphQL arguments besides the datasets.
   * @returns The result, or the errors.
   */
  async function compareAggregatesTrade(args: string) {
    return execute(server, {
      query: `query {
        compareAggregatedFacts(
          catalogA: "default", schemaA: "trade",
          catalogB: "macroeconomics", schemaB: "trade",
          ${args}
        ) {
          groupBy { name labelColumn }
          aggregates { alias measure aggregation sqlType unit displayFormat extent }
          columns data total hasNextPage
        }
      }`,
    });
  }

  test('colonnes _a/_b/_delta/_delta_pct égales à la référence DuckDB', async () => {
    const result = await compareAggregatesTrade(`
      groupBy: [{ field: "nc8" }]
      aggregates: [
        { measure: "value" }
        { measure: "value", aggregation: AVG, alias: "moyenne" }
        { measure: "weight_kg" }
      ]
    `);
    expect(result.errors).toBeUndefined();
    const r = result.data!.compareAggregatedFacts as {
      aggregates: Array<{ alias: string; unit: string | null; extent: [number, number] | null }>;
      columns: string[];
      data: Array<Record<string, number | string | null>>;
      total: number;
      hasNextPage: boolean;
    };

    expect(r.total).toBe(3);
    expect(r.hasNextPage).toBe(false);
    const aliases = ['value_sum', 'moyenne', 'weight_kg_sum'];
    expect(r.aggregates.map((a) => a.alias)).toEqual(aliases);
    expect(r.aggregates.map((a) => a.unit)).toEqual(['€', '€', 'kg']);
    expect(r.columns).toEqual([
      'nc8',
      'nc8__label',
      ...aliases.flatMap((alias) => [
        `${alias}_a`,
        `${alias}_b`,
        `${alias}_delta`,
        `${alias}_delta_pct`,
      ]),
    ]);
    expect(r.data.map((row) => row.nc8)).toEqual(SHARED_NC8);

    const references: Array<[string, string]> = [
      ['value_sum', 'SUM(value)'],
      ['moyenne', 'AVG(value)'],
      ['weight_kg_sum', 'SUM(weight_kg)'],
    ];
    for (const [alias, aggregate] of references) {
      const reference = await referenceByNc8(aggregate);
      for (const row of r.data) {
        const [a, b] = reference.get(row.nc8 as string)!;
        expect(row[`${alias}_a`]).toBeCloseTo(a, 6);
        expect(row[`${alias}_b`]).toBeCloseTo(b, 6);
        expect(row[`${alias}_delta`]).toBeCloseTo(b - a, 6);
        expect(row[`${alias}_delta_pct`]).toBeCloseTo(((b - a) / a) * 100, 6);
      }
      // Étendue commune aux deux côtés (axe partagé)
      const extent = r.aggregates.find((agg) => agg.alias === alias)!.extent!;
      const values = [...reference.values()].flat();
      expect(extent[0]).toBeCloseTo(Math.min(...values), 6);
      expect(extent[1]).toBeCloseTo(Math.max(...values), 6);
    }
  });

  test('tri sur un écart, départagé par les groupes, et pagination', async () => {
    const result = await compareAggregatesTrade(`
      groupBy: [{ field: "nc8" }, { field: "partner_code" }]
      aggregates: [{ measure: "value" }]
      sort: [{ by: "value_sum_delta", order: DESC }]
      limit: 4
    `);
    expect(result.errors).toBeUndefined();
    const r = result.data!.compareAggregatedFacts as {
      data: Array<Record<string, number>>;
      total: number;
      hasNextPage: boolean;
    };
    expect(r.total).toBe(6);
    expect(r.hasNextPage).toBe(true);
    const deltas = r.data.map((row) => row.value_sum_delta);
    expect(deltas).toEqual([...deltas].sort((x, y) => y - x));
  });

  test('sans groupe : une seule ligne globale', async () => {
    const result = await compareAggregatesTrade('aggregates: [{ measure: "value" }]');
    expect(result.errors).toBeUndefined();
    const r = result.data!.compareAggregatedFacts as {
      data: Array<Record<string, number>>;
      total: number;
    };
    expect(r.total).toBe(1);
    expect(r.data).toHaveLength(1);
    const [reference] = await referenceRows(
      `SELECT (SELECT SUM(value) FROM "macroeconomics"."trade"."fact_table") -
              (SELECT SUM(value) FROM "default"."trade"."fact_table") AS d`,
    );
    expect(r.data[0].value_sum_delta).toBeCloseTo(Number(reference.d), 6);
  });

  test('collision de colonne, agrégat non numérique, tri inconnu → BAD_USER_INPUT', async () => {
    const collision = await compareAggregatesTrade(`
      groupBy: [{ field: "nc8" }]
      aggregates: [{ measure: "value", alias: "nc8" }]
    `);
    expect(collision.errors![0].extensions?.code).toBe('BAD_USER_INPUT');

    const text = await compareAggregatesTrade(
      'aggregates: [{ measure: "partner_libelle", aggregation: MODE }]',
    );
    expect(text.errors![0].extensions?.code).toBe('BAD_USER_INPUT');

    const sort = await compareAggregatesTrade(
      'aggregates: [{ measure: "value" }], sort: [{ by: "value_sum" }]',
    );
    expect(sort.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
  });
});
