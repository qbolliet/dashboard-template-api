/**
 * Acceptance tests for column names outside [A-Za-z0-9_] (audit BA3).
 *
 * The database accepts any column name; the `default.emploi` fixture declares
 * "zone d'emploi", "Année" and "taux chômage" (the first two form cluster_by).
 * Every one of them must be projectable, filterable, sortable and groupable —
 * identifiers are checked against metadata, then quoted.
 *
 * Fixture values: taux chômage = 5 + 2 × zone rank + 0.5 × (year − 2022),
 * zones Lyon (0), Paris (1), Val-d'Oise (2), years 2022 to 2024.
 */

import { ApolloServer } from '@apollo/server';
import { ensureSetup, getServer, execute } from './helpers.js';

// ─── État partagé ─────────────────────────────────────────────────────────────

let server: ApolloServer;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
}, 60000);

/** Row of getFactTable, keys and measures merged into one record. */
type Row = Record<string, unknown>;

/**
 * Runs getFactTable on the `emploi` schema and flattens each row.
 *
 * @param args - Extra GraphQL arguments (fields, sort, structuredFilters…).
 * @param variables - GraphQL variables.
 * @returns The flattened rows and the total.
 */
// Lecture de la fact_table « emploi », lignes aplaties en { colonne: valeur }
async function emploiFacts(
  args: string,
  variables: Record<string, unknown> = {},
): Promise<{ rows: Row[]; total: number }> {
  const result = await execute(server, {
    query: `
      query Q($f: FilterNode) {
        getFactTable(schema: "emploi", structuredFilters: $f, limit: 100 ${args}) {
          data { keys { name value } measures { name value } }
          total
        }
      }
    `,
    variables,
  });
  expect(result.errors).toBeUndefined();
  const page = result.data!.getFactTable as {
    data: Array<{ keys: Row[]; measures: Row[] }>;
    total: number;
  };
  const rows = page.data.map(({ keys, measures }) =>
    Object.fromEntries([...keys, ...measures].map(({ name, value }) => [name, value])),
  );
  return { rows, total: page.total };
}

// ─── Faits ────────────────────────────────────────────────────────────────────

describe('getFactTable — noms de colonnes avec espace, accent, apostrophe', () => {
  test('projection de "taux chômage" et "Année"', async () => {
    const { rows, total } = await emploiFacts(', fields: ["taux chômage", "Année"]');

    expect(total).toBe(9);
    expect(Object.keys(rows[0]).sort()).toEqual(['Année', 'taux chômage']);
  });

  test('tri par défaut sur cluster_by ("zone d\'emploi", "Année"), non ignoré', async () => {
    const { rows } = await emploiFacts('');

    expect(rows.map((row) => [row["zone d'emploi"], row['Année']])).toEqual([
      ['Lyon', 2022],
      ['Lyon', 2023],
      ['Lyon', 2024],
      ['Paris', 2022],
      ['Paris', 2023],
      ['Paris', 2024],
      ["Val-d'Oise", 2022],
      ["Val-d'Oise", 2023],
      ["Val-d'Oise", 2024],
    ]);
  });

  test('filtre sur "taux chômage"', async () => {
    const { total } = await emploiFacts('', {
      f: { children: [{ criterion: { variable: 'taux chômage', operation: 'GT', value: 7 } }] },
    });

    // 7.5, 8, 9, 9.5, 10
    expect(total).toBe(5);
  });

  test('filtre sur "zone d\'emploi" (apostrophe dans le nom et dans la valeur)', async () => {
    const { rows } = await emploiFacts('', {
      f: {
        children: [
          { criterion: { variable: "zone d'emploi", operation: 'EQ', value: "Val-d'Oise" } },
        ],
      },
    });

    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row["zone d'emploi"] === "Val-d'Oise")).toBe(true);
  });

  test('tri explicite DESC sur "taux chômage"', async () => {
    const { rows } = await emploiFacts(', sort: [{ field: "taux chômage", order: DESC }]');

    const rates = rows.map((row) => Number(row['taux chômage']));
    expect(rates).toEqual([...rates].sort((a, b) => b - a));
    expect(rates[0]).toBe(10);
  });

  test('getFactTableWithMetadata renvoie les colonnes et leurs métadonnées', async () => {
    const result = await execute(server, {
      query: `query {
        getFactTableWithMetadata(schema: "emploi", fields: ["taux chômage"], limit: 3) {
          columns
          fields { name label }
        }
      }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data!.getFactTableWithMetadata).toEqual({
      columns: ['taux chômage'],
      fields: [{ name: 'taux chômage', label: 'Taux de chômage' }],
    });
  });
});

// ─── Agrégations ──────────────────────────────────────────────────────────────

describe('getAggregatedFacts — regroupement', () => {
  test('groupBy "zone d\'emploi", AVG de "taux chômage"', async () => {
    const result = await execute(server, {
      query: `query {
        getAggregatedFacts(schema: "emploi", groupBy: "zone d'emploi", measure: "taux chômage", aggregation: AVG) {
          key aggregatedValue count
        }
      }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data!.getAggregatedFacts).toEqual([
      { key: 'Lyon', aggregatedValue: 5.5, count: 3 },
      { key: 'Paris', aggregatedValue: 7.5, count: 3 },
      { key: "Val-d'Oise", aggregatedValue: 9.5, count: 3 },
    ]);
  });

  test('groupBy "taux chômage", COUNT de "Année"', async () => {
    const result = await execute(server, {
      query: `query {
        getAggregatedFacts(schema: "emploi", groupBy: "taux chômage", measure: "Année", aggregation: COUNT) {
          key aggregatedValue
        }
      }`,
    });

    expect(result.errors).toBeUndefined();
    const groups = result.data!.getAggregatedFacts as Array<{
      key: string;
      aggregatedValue: number;
    }>;
    // Neuf taux distincts (5 à 10), une ligne chacun, triés par clé
    expect(groups.map((group) => Number(group.key))).toEqual([5, 5.5, 6, 7, 7.5, 8, 9, 9.5, 10]);
    expect(groups.every((group) => group.aggregatedValue === 1)).toBe(true);
  });

  test('la mesure par défaut applique defaultAggregation (AVG)', async () => {
    const result = await execute(server, {
      query: `query {
        getAggregatedFacts(schema: "emploi", groupBy: "Année", measure: "taux chômage") {
          key aggregatedValue
        }
      }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data!.getAggregatedFacts).toEqual([
      { key: '2022', aggregatedValue: 7 },
      { key: '2023', aggregatedValue: 7.5 },
      { key: '2024', aggregatedValue: 8 },
    ]);
  });
});

// ─── Options et statistiques ──────────────────────────────────────────────────

describe('options de sélection et statistiques', () => {
  test('getSelectOptions(fieldName: "zone d\'emploi")', async () => {
    const result = await execute(server, {
      query: `query { getSelectOptions(schema: "emploi", fieldName: "zone d'emploi") { value label } }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data!.getSelectOptions).toEqual([
      { value: 'Lyon', label: 'Lyon' },
      { value: 'Paris', label: 'Paris' },
      { value: "Val-d'Oise", label: "Val-d'Oise" },
    ]);
  });

  test('getFieldStats(fieldName: "taux chômage")', async () => {
    const result = await execute(server, {
      query: `query {
        getFieldStats(schema: "emploi", fieldName: "taux chômage") { min max distinctCount nullCount }
      }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data!.getFieldStats).toEqual({ min: 5, max: 10, distinctCount: 9, nullCount: 0 });
  });
});
