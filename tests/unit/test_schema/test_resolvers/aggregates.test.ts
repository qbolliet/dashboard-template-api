/**
 * Integration tests for the getAggregates resolver, on the real test catalogs.
 *
 * Covers several aggregates in one query (the example of audit-api.md §4.2),
 * the global aggregate, the time grains (DATE and TIMESTAMP, several temporal
 * columns at once), the three formats (LONG being OBJECTS melted), labels,
 * the description of the columns (type, unit, format, extent), filters,
 * sorting, pagination, variables, the bounds and the input errors.
 */

import { jest } from '@jest/globals';
import { ApolloServer } from '@apollo/server';
import { clearAggregatedCache, ensureSetup, getServer, execute } from './helpers.js';
import { AggregatesLoader } from '../../../../src/loaders/aggregates.js';
import type { GraphQLResult } from './helpers.js';

// ─── État partagé ─────────────────────────────────────────────────────────────

// Serveur Apollo réutilisé par tous les tests du fichier
let server: ApolloServer;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
  // Entrées d'une exécution précédente, calculées sur d'autres données de test
  await clearAggregatedCache();
}, 60000);

// ─── Interfaces et fonctions utilitaires ──────────────────────────────────────

/** Description of an aggregate column. */
interface AggregateColumn {
  alias: string;
  measure: string;
  aggregation: string;
  sqlType: string;
  unit: string | null;
  displayFormat: string | null;
  extent: unknown;
  field: { name: string };
}

/** Description of a group column. */
interface GroupColumn {
  name: string;
  grain: string | null;
  labelColumn: string | null;
  extent: unknown;
  field: { name: string; typeFamily: string };
}

/** Payload of getAggregates, every field selected. */
interface AggregatePayload {
  groupBy: GroupColumn[];
  aggregates: AggregateColumn[];
  columns: string[];
  data: Record<string, unknown>[];
  total: number;
  hasNextPage: boolean;
  generatedAt: string;
}

// Sélection complète du résultat
const SELECTION = `
  groupBy { name grain labelColumn extent field { name typeFamily } }
  aggregates { alias measure aggregation sqlType unit displayFormat extent field { name } }
  columns data total hasNextPage generatedAt
`;

/**
 * Runs getAggregates with the given arguments.
 *
 * @param args - GraphQL arguments, already formatted.
 * @returns The GraphQL result.
 */
// Exécution de getAggregates
const run = (args: string): Promise<GraphQLResult> =>
  execute(server, { query: `query { getAggregates(${args}) { ${SELECTION} } }` });

/**
 * Runs getAggregates and returns its payload, failing on any error.
 *
 * @param args - GraphQL arguments, already formatted.
 * @returns The payload.
 */
// Résultat sans erreur admise
const aggregates = async (args: string): Promise<AggregatePayload> => {
  const result = await run(args);
  expect(result.errors).toBeUndefined();
  return result.data!.getAggregates as AggregatePayload;
};

/**
 * Asserts a BAD_USER_INPUT error.
 *
 * @param args - GraphQL arguments, already formatted.
 * @param fragment - Substring expected in the error message.
 */
// Rejet BAD_USER_INPUT attendu
const expectBadInput = async (args: string, fragment: string): Promise<void> => {
  const result = await run(args);
  expect(result.errors).toBeDefined();
  expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
  expect(result.errors![0].message).toContain(fragment);
};

/**
 * Sum of a numeric column over rows.
 *
 * @param rows - Rows.
 * @param column - Column to sum.
 * @returns The sum.
 */
// Somme d'une colonne
const sumOf = (rows: Record<string, unknown>[], column: string): number =>
  rows.reduce((total, row) => total + Number(row[column] ?? 0), 0);

// ─── Plusieurs agrégats ───────────────────────────────────────────────────────

describe('plusieurs agrégats en une requête', () => {
  test('exemple audit-api.md §4.2 : SUM, AVG de value et MAX de lower_bound par pays', async () => {
    const payload = await aggregates(`
      groupBy: [{ field: "country" }]
      aggregates: [
        { measure: "value", aggregation: SUM }
        { measure: "value", aggregation: AVG }
        { measure: "lower_bound", aggregation: MAX }
      ]
      limit: 50
    `);

    expect(payload.columns).toEqual([
      'country',
      'value_sum',
      'value_avg',
      'lower_bound_max',
      'row_count',
    ]);
    expect(payload.data.length).toBeGreaterThan(0);
    for (const row of payload.data) {
      // AVG × effectif = SUM (value n'a pas de NULL dans main)
      expect(row.value_avg as number).toBeCloseTo(
        (row.value_sum as number) / (row.row_count as number),
      );
      expect(typeof row.lower_bound_max).toBe('number');
    }
    expect(payload.total).toBe(payload.data.length);
    expect(payload.hasNextPage).toBe(false);
    expect(payload.data.map((row) => row.country)).toContain('France');
  });

  test('une seule requête SQL pour tous les agrégats d’une page', async () => {
    const spy = jest.spyOn(AggregatesLoader.prototype, 'loadPage');
    try {
      // Filtre propre à ce test : jamais servi par une entrée de cache existante
      const threshold = -1e9 - Math.floor(Math.random() * 1e6);
      await aggregates(`
        groupBy: [{ field: "country" }]
        aggregates: [{ measure: "value", aggregation: SUM }, { measure: "value", aggregation: AVG }, { measure: "lower_bound", aggregation: MAX }]
        structuredFilters: { children: [{ criterion: { variable: "value", operation: GT, value: ${threshold} } }] }
      `);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('description des colonnes : type lu dans le résultat, unité, format, extent', async () => {
    const payload = await aggregates(`
      groupBy: [{ field: "country" }]
      aggregates: [
        { measure: "value", aggregation: SUM }
        { measure: "headcount", aggregation: SUM }
        { measure: "value", aggregation: COUNT }
        { measure: "lower_bound", aggregation: MAX }
      ]
      limit: 50
    `);
    const byAlias = new Map(payload.aggregates.map((column) => [column.alias, column]));

    expect(byAlias.get('value_sum')).toMatchObject({
      measure: 'value',
      aggregation: 'SUM',
      sqlType: 'DOUBLE',
      unit: '€',
      displayFormat: ',.2f',
      field: { name: 'value' },
    });
    expect(byAlias.get('headcount_sum')!.sqlType).toBe('HUGEINT');
    expect(byAlias.get('value_count')).toMatchObject({
      sqlType: 'BIGINT',
      unit: null,
      displayFormat: ',d',
    });
    expect(byAlias.get('lower_bound_max')!.sqlType).toBe('FLOAT');

    const sums = payload.data.map((row) => row.value_sum as number);
    expect(byAlias.get('value_sum')!.extent).toEqual([Math.min(...sums), Math.max(...sums)]);
    expect(payload.groupBy).toEqual([
      {
        name: 'country',
        grain: null,
        labelColumn: null,
        extent: null,
        field: { name: 'country', typeFamily: 'TEXT' },
      },
    ]);
  });
});

// ─── Agrégat global ───────────────────────────────────────────────────────────

describe('agrégat global (sans groupBy)', () => {
  test('une seule ligne, total 1, cohérente avec le détail par groupe', async () => {
    const global = await aggregates(
      'aggregates: [{ measure: "value", aggregation: SUM }, { measure: "headcount", aggregation: SUM }]',
    );
    const byCountry = await aggregates(
      'groupBy: [{ field: "country" }], aggregates: [{ measure: "value", aggregation: SUM }], limit: 100',
    );
    const facts = await execute(server, { query: 'query { getFactTable(limit: 1) { total } }' });

    expect(global.total).toBe(1);
    expect(global.hasNextPage).toBe(false);
    expect(global.groupBy).toEqual([]);
    expect(global.columns).toEqual(['value_sum', 'headcount_sum', 'row_count']);
    expect(global.data).toHaveLength(1);
    const [row] = global.data;
    expect(row.value_sum as number).toBeCloseTo(sumOf(byCountry.data, 'value_sum'), 6);
    expect(row.row_count).toBe((facts.data!.getFactTable as { total: number }).total);
    // Somme d'un BIGINT au-delà de 2^53 : chaîne décimale exacte
    expect(row.headcount_sum).toMatch(/^\d+$/);
  });
});

// ─── Grains temporels ─────────────────────────────────────────────────────────

describe('grains temporels', () => {
  test('MONTH sur une DATE : un groupe par mois, valeur au premier jour', async () => {
    const raw = await aggregates(
      'groupBy: [{ field: "date" }], aggregates: [{ measure: "value", aggregation: SUM }], limit: 1000',
    );
    const month = await aggregates(
      'groupBy: [{ field: "date", grain: MONTH }], aggregates: [{ measure: "value", aggregation: SUM }], limit: 1000',
    );

    expect(month.groupBy[0]).toMatchObject({ name: 'date', grain: 'MONTH', labelColumn: null });
    expect(month.data.every((row) => /^\d{4}-\d{2}-01$/.test(row.date as string))).toBe(true);
    // Un groupe par mois distinct des dates brutes, aucune ligne perdue
    const rawMonths = new Set(raw.data.map((row) => `${(row.date as string).slice(0, 7)}-01`));
    expect(month.data.map((row) => row.date)).toEqual([...rawMonths].sort());
    expect(sumOf(month.data, 'row_count')).toBe(sumOf(raw.data, 'row_count'));
    // Extent ISO de la colonne de groupe
    const dates = month.data.map((row) => row.date as string).sort();
    expect(month.groupBy[0].extent).toEqual([dates[0], dates[dates.length - 1]]);
  });

  test('QUARTER et YEAR regroupent les mois, sans perdre de ligne', async () => {
    const quarter = await aggregates(
      'groupBy: [{ field: "date", grain: QUARTER }], aggregates: [{ measure: "value" }], limit: 1000',
    );
    const year = await aggregates(
      'groupBy: [{ field: "date", grain: YEAR }], aggregates: [{ measure: "value" }], limit: 1000',
    );

    expect(quarter.data.every((row) => /^\d{4}-(01|04|07|10)-01$/.test(row.date as string))).toBe(
      true,
    );
    expect(year.data.every((row) => /^\d{4}-01-01$/.test(row.date as string))).toBe(true);
    expect(year.total).toBeLessThan(quarter.total);
    expect(sumOf(year.data, 'row_count')).toBe(sumOf(quarter.data, 'row_count'));
    expect(sumOf(year.data, 'value_sum')).toBeCloseTo(sumOf(quarter.data, 'value_sum'), 6);
  });

  test('YEAR sur la date du schéma geography', async () => {
    const payload = await aggregates(
      'schema: "geography", groupBy: [{ field: "date", grain: YEAR }], aggregates: [{ measure: "population" }]',
    );

    expect(payload.data.map((row) => row.date)).toEqual(['2023-01-01', '2024-01-01']);
  });

  test('DAY, HOUR et MINUTE sur un TIMESTAMP', async () => {
    const at = async (grain: string): Promise<string[]> =>
      (
        await aggregates(
          `groupBy: [{ field: "ingested_at", grain: ${grain} }], aggregates: [{ measure: "value" }], limit: 3`,
        )
      ).data.map((row) => row.ingested_at as string);

    // ingested_at vaut date + 03:15:00
    expect((await at('DAY')).every((value) => value.endsWith('T00:00:00'))).toBe(true);
    expect((await at('HOUR')).every((value) => value.endsWith('T03:00:00'))).toBe(true);
    expect((await at('MINUTE')).every((value) => value.endsWith('T03:15:00'))).toBe(true);
  });

  test('deux colonnes temporelles à grains différents dans le même groupBy', async () => {
    const payload = await aggregates(`
      groupBy: [{ field: "date", grain: MONTH }, { field: "ingested_at", grain: DAY }]
      aggregates: [{ measure: "value" }]
      limit: 1000
    `);
    const rawDates = await aggregates(
      'groupBy: [{ field: "date" }], aggregates: [{ measure: "value" }], limit: 1000',
    );

    expect(payload.groupBy.map((group) => [group.name, group.grain])).toEqual([
      ['date', 'MONTH'],
      ['ingested_at', 'DAY'],
    ]);
    // ingested_at vaut date + 03:15 : son jour est la date brute, dans le mois de date
    for (const row of payload.data) {
      expect(row.ingested_at as string).toMatch(/T00:00:00$/);
      expect(`${(row.ingested_at as string).slice(0, 7)}-01`).toBe(row.date);
    }
    // Un couple (mois, jour) par date brute
    expect(payload.total).toBe(rawDates.total);
  });

  test('grain infra-journalier sur une DATE, grain sur un texte → BAD_USER_INPUT', async () => {
    await expectBadInput(
      'groupBy: [{ field: "date", grain: HOUR }], aggregates: [{ measure: "value" }]',
      'Allowed grains: DAY, WEEK, MONTH, QUARTER, YEAR',
    );
    await expectBadInput(
      'groupBy: [{ field: "country", grain: MONTH }], aggregates: [{ measure: "value" }]',
      'grain applies to DATE and TIMESTAMP columns only',
    );
  });
});

// ─── Formats ──────────────────────────────────────────────────────────────────

describe('formats', () => {
  const ARGS = `
    groupBy: [{ field: "country" }, { field: "date", grain: YEAR }]
    aggregates: [{ measure: "value", aggregation: SUM }, { measure: "lower_bound", aggregation: MIN, alias: "low" }]
    limit: 6
  `;

  test('LONG est OBJECTS fondu sur les alias', async () => {
    const objects = await aggregates(ARGS);
    const long = await aggregates(`${ARGS} format: LONG`);

    expect(long.columns).toEqual(['country', 'date', 'row_count', 'measure', 'value']);
    expect(long.data).toEqual(
      objects.data.flatMap((row) =>
        ['value_sum', 'low'].map((alias) => ({
          country: row.country,
          date: row.date,
          row_count: row.row_count,
          measure: alias,
          value: row[alias],
        })),
      ),
    );
    // La pagination porte sur les groupes
    expect(long.total).toBe(objects.total);
    expect(long.aggregates).toEqual(objects.aggregates);
  });

  test('ARRAYS suit l’ordre de columns', async () => {
    const objects = await aggregates(ARGS);
    const arrays = await aggregates(`${ARGS} format: ARRAYS`);

    expect(arrays.columns).toEqual(objects.columns);
    expect(arrays.data).toEqual(
      objects.data.map((row) => objects.columns.map((column) => row[column])),
    );
  });

  test('LONG refuse une colonne de groupe nommée value', async () => {
    await expectBadInput(
      'groupBy: [{ field: "value" }], aggregates: [{ measure: "horizon" }], format: LONG',
      'The LONG format names its columns measure and value',
    );
  });
});

// ─── Libellés ─────────────────────────────────────────────────────────────────

describe('colonnes de libellés', () => {
  test('nc8__label lu par ANY_VALUE dans la même requête', async () => {
    const payload = await aggregates(
      'schema: "trade", groupBy: [{ field: "nc8" }], aggregates: [{ measure: "value" }], limit: 50',
    );

    expect(payload.groupBy[0].labelColumn).toBe('nc8__label');
    expect(payload.columns).toEqual(['nc8', 'nc8__label', 'value_sum', 'row_count']);
    const horses = payload.data.find((row) => row.nc8 === '01012100');
    expect(horses!.nc8__label).toBe('Pure-bred breeding horses');
    // Code sans libellé : null, pas de chaîne vide
    expect(payload.data.find((row) => row.nc8 === '02013090')!.nc8__label).toBeNull();
  });

  test('colonne sans colonne de libellés : labelColumn null, pas de colonne __label', async () => {
    const payload = await aggregates(
      'groupBy: [{ field: "country" }], aggregates: [{ measure: "value" }], limit: 3',
    );

    expect(payload.groupBy[0].labelColumn).toBeNull();
    expect(payload.columns.some((column) => column.endsWith('__label'))).toBe(false);
  });
});

// ─── Filtres, tri, pagination ─────────────────────────────────────────────────

describe('filtres, tri et pagination', () => {
  test('le COUNT filtré recoupe le nombre de faits filtrés', async () => {
    const tree = {
      children: [
        { criterion: { variable: 'value', operation: 'GT', value: 0 } },
        {
          connector: 'AND',
          children: [
            { criterion: { variable: 'kind', operation: 'EQ', value: 'Actual' } },
            {
              connector: 'OR',
              criterion: { variable: 'kind', operation: 'EQ', value: 'Forecast' },
            },
          ],
        },
      ],
    };
    const result = await execute(server, {
      query: `
        query Agg($f: FilterNode) {
          agg: getAggregates(groupBy: [{ field: "kind" }], aggregates: [{ measure: "value", aggregation: COUNT }], structuredFilters: $f) { data }
          facts: getFactTable(structuredFilters: $f, limit: 1) { total }
        }
      `,
      variables: { f: tree },
    });

    expect(result.errors).toBeUndefined();
    const rows = (result.data!.agg as { data: Record<string, unknown>[] }).data;
    expect(rows.every((row) => ['Actual', 'Forecast'].includes(row.kind as string))).toBe(true);
    expect(sumOf(rows, 'value_count')).toBe((result.data!.facts as { total: number }).total);
    expect(sumOf(rows, 'row_count')).toBe((result.data!.facts as { total: number }).total);
  });

  test('erreur de validation du filtre remontée en BAD_USER_INPUT', async () => {
    await expectBadInput(
      `groupBy: [{ field: "indicator" }], aggregates: [{ measure: "value" }]
       structuredFilters: { children: [{ criterion: { variable: "value", operation: CONTAINS, value: "1" } }] }`,
      'Allowed operations',
    );
  });

  test('tri décroissant sur un alias', async () => {
    const payload = await aggregates(`
      groupBy: [{ field: "country" }]
      aggregates: [{ measure: "value", aggregation: SUM }]
      sort: [{ by: "value_sum", order: DESC }]
    `);
    const values = payload.data.map((row) => row.value_sum as number);

    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]).toBeLessThanOrEqual(values[index - 1]);
    }
  });

  test('pages successives disjointes et complètes', async () => {
    const all = await aggregates(
      'groupBy: [{ field: "country" }], aggregates: [{ measure: "value" }], limit: 100',
    );
    const first = await aggregates(
      'groupBy: [{ field: "country" }], aggregates: [{ measure: "value" }], limit: 2, offset: 0',
    );
    const second = await aggregates(
      'groupBy: [{ field: "country" }], aggregates: [{ measure: "value" }], limit: 2, offset: 2',
    );

    expect(first.hasNextPage).toBe(true);
    expect([...first.data, ...second.data]).toEqual(all.data.slice(0, 4));
  });

  test('variables, groupBy et aggregates compris', async () => {
    const result = await execute(server, {
      query: `
        query Vars($groupBy: [GroupByInput!], $aggregates: [AggregateInput!]!, $limit: Int!) {
          getAggregates(groupBy: $groupBy, aggregates: $aggregates, limit: $limit) { data total }
        }
      `,
      variables: {
        groupBy: [{ field: 'country' }],
        aggregates: [{ measure: 'value', aggregation: 'AVG', alias: 'mean' }],
        limit: 5,
      },
    });

    expect(result.errors).toBeUndefined();
    const payload = result.data!.getAggregates as { data: Record<string, unknown>[] };
    expect(payload.data.length).toBeLessThanOrEqual(5);
    expect(payload.data[0]).toHaveProperty('mean');
  });

  test('mille groupes en moins de 10 s', async () => {
    const start = Date.now();
    const payload = await aggregates(
      'groupBy: [{ field: "date" }, { field: "country" }], aggregates: [{ measure: "value", aggregation: AVG }], limit: 1000',
    );

    expect(payload.data.length).toBeGreaterThan(0);
    expect(Date.now() - start).toBeLessThan(10000);
  });
});

// ─── Erreurs d'entrée et bornes ───────────────────────────────────────────────

describe('erreurs d’entrée et bornes', () => {
  test('colonne malformée ou inconnue → BAD_USER_INPUT', async () => {
    await expectBadInput(
      'groupBy: [{ field: "country; DROP TABLE fact_table" }], aggregates: [{ measure: "value" }]',
      'Unknown groupBy column(s)',
    );
    await expectBadInput('aggregates: [{ measure: "nope" }]', 'Unknown measure column(s)');
  });

  test('aggregates est obligatoire et non vide', async () => {
    const missing = await execute(server, { query: 'query { getAggregates { total } }' });
    expect(missing.errors).toBeDefined();
    expect(missing.errors![0].message).toContain('aggregates');

    await expectBadInput('aggregates: []', 'at least one aggregate');
  });

  test('au-delà de MAX_AGGREGATES et MAX_GROUP_BY → BAD_USER_INPUT', async () => {
    const many = Array.from(
      { length: 21 },
      (_, index) => `{ measure: "value", alias: "a${index}" }`,
    );
    await expectBadInput(`aggregates: [${many.join(', ')}]`, 'cannot hold more than 20 aggregates');
    await expectBadInput(
      `groupBy: [{ field: "country" }, { field: "indicator" }, { field: "kind" }, { field: "model" }, { field: "training" }]
       aggregates: [{ measure: "value" }]`,
      'cannot hold more than 4 columns',
    );
  });

  test('alias invalide ou en double, tri inconnu → BAD_USER_INPUT', async () => {
    await expectBadInput('aggregates: [{ measure: "value", alias: "Total" }]', 'must match');
    await expectBadInput(
      'aggregates: [{ measure: "value", aggregation: SUM }, { measure: "value", aggregation: SUM }]',
      'is produced more than once',
    );
    await expectBadInput(
      'groupBy: [{ field: "country" }], aggregates: [{ measure: "value" }], sort: [{ by: "lower_bound" }]',
      'Unknown sort column',
    );
  });

  test('pagination hors bornes → BAD_USER_INPUT', async () => {
    await expectBadInput('aggregates: [{ measure: "value" }], limit: 0', 'Limit');
    await expectBadInput('aggregates: [{ measure: "value" }], offset: 100000', 'Offset');
  });

  test('agrégation inconnue rejetée par la validation GraphQL', async () => {
    const result = await run('aggregates: [{ measure: "value", aggregation: INVALID_AGG }]');

    expect(result.errors).toBeDefined();
    expect(result.errors![0].message).toContain('Aggregation');
  });
});
