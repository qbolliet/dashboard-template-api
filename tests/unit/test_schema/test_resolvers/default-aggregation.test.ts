/**
 * Integration tests for the implicit aggregation of getAggregates.
 *
 * The `aggregation` of an AggregateInput is optional and carries no SDL
 * default. When the client omits it, the measure's
 * `metadata.defaultAggregation` applies, and SUM closes the chain for a
 * numeric measure only (revue-technique-api.md §5.1); a non-numeric measure
 * without default is a client error. The rule applies per aggregate.
 *
 * The fixtures make the distinction observable: `quality_score` declares AVG,
 * `value` declares SUM, `lower_bound` MIN, `upper_bound` MAX, `horizon`
 * (INTEGER) and `is_provisional` (BOOLEAN) declare nothing at all.
 */

import { ApolloServer } from '@apollo/server';
import { clearAggregatedCache, ensureSetup, getServer, execute } from './helpers.js';

// ─── État partagé ─────────────────────────────────────────────────────────────

// Serveur Apollo réutilisé par tous les tests du fichier
let server: ApolloServer;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
  // Entrées d'une exécution précédente, calculées sur d'autres données de test
  await clearAggregatedCache();
}, 60000);

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

/**
 * Runs getAggregates on one measure, with or without an explicit aggregation.
 *
 * The alias is fixed so that both forms are comparable row by row.
 *
 * @param measure - Measure column to aggregate.
 * @param aggregation - Explicit aggregation, or null to omit the argument.
 * @returns The aggregated values, keyed by country.
 */
// Exécution d'une agrégation, l'argument étant omis quand aggregation est null
const aggregate = async (
  measure: string,
  aggregation: string | null,
): Promise<Map<string, unknown>> => {
  const arg = aggregation === null ? '' : `aggregation: ${aggregation}, `;
  const result = await execute(server, {
    query: `query {
      getAggregates(
        schema: "main"
        groupBy: [{ field: "country" }]
        aggregates: [{ measure: "${measure}", ${arg}alias: "v" }]
        limit: 100
      ) { data }
    }`,
  });

  expect(result.errors).toBeUndefined();
  const rows = (result.data!.getAggregates as { data: Record<string, unknown>[] }).data;
  return new Map(rows.map((row) => [row.country as string, row.v]));
};

// ─── Agrégation par défaut ────────────────────────────────────────────────────

describe('agrégation implicite', () => {
  test('une mesure déclarant AVG est moyennée quand l’argument est omis', async () => {
    const implicit = await aggregate('quality_score', null);
    const avg = await aggregate('quality_score', 'AVG');
    const sum = await aggregate('quality_score', 'SUM');

    expect(implicit).toEqual(avg);
    // La distinction doit être observable, sinon le test ne prouve rien
    expect(implicit).not.toEqual(sum);
  });

  test('une mesure déclarant SUM est sommée quand l’argument est omis', async () => {
    expect(await aggregate('value', null)).toEqual(await aggregate('value', 'SUM'));
  });

  test('une mesure numérique sans agrégation déclarée retombe sur SUM', async () => {
    // `horizon` (INTEGER) ne déclare aucune defaultAggregation
    expect(await aggregate('horizon', null)).toEqual(await aggregate('horizon', 'SUM'));
  });

  test('une mesure non numérique sans agrégation déclarée est rejetée (pas de COUNT implicite)', async () => {
    // `is_provisional` (BOOLEAN) ne déclare aucune defaultAggregation
    const result = await execute(server, {
      query: `query {
        getAggregates(schema: "main", groupBy: [{ field: "country" }], aggregates: [{ measure: "is_provisional" }]) { data }
      }`,
    });

    expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(result.errors![0].message).toContain('declares no defaultAggregation');
    expect(result.errors![0].message).toContain('allowed: COUNT, MODE');
  });

  test('l’argument explicite l’emporte sur la métadonnée', async () => {
    const explicit = await aggregate('quality_score', 'MAX');
    const implicit = await aggregate('quality_score', null);

    expect(explicit).not.toEqual(implicit);
    // MAX borne bien chaque groupe par le haut ; un groupe sans valeur est
    // null pour les deux agrégations (pas de 0 fictif)
    for (const [key, value] of explicit) {
      if (value === null) {
        expect(implicit.get(key)).toBeNull();
        continue;
      }
      expect(value).toBeGreaterThanOrEqual(implicit.get(key) as number);
    }
  });

  test('chaque agrégat d’une même requête suit le défaut de sa propre mesure', async () => {
    const result = await execute(server, {
      query: `query {
        getAggregates(
          schema: "main"
          aggregates: [{ measure: "value" }, { measure: "lower_bound" }, { measure: "upper_bound" }, { measure: "quality_score" }]
        ) { columns aggregates { alias aggregation } }
      }`,
    });

    expect(result.errors).toBeUndefined();
    const payload = result.data!.getAggregates as {
      columns: string[];
      aggregates: { alias: string; aggregation: string }[];
    };
    expect(payload.aggregates).toEqual([
      { alias: 'value_sum', aggregation: 'SUM' },
      { alias: 'lower_bound_min', aggregation: 'MIN' },
      { alias: 'upper_bound_max', aggregation: 'MAX' },
      { alias: 'quality_score_avg', aggregation: 'AVG' },
    ]);
    expect(payload.columns).toEqual([
      'value_sum',
      'lower_bound_min',
      'upper_bound_max',
      'quality_score_avg',
      'row_count',
    ]);
  });

  test('les métadonnées des colonnes remontent en camelCase', async () => {
    const result = await execute(server, {
      query: `query {
        getAggregates(
          schema: "main"
          groupBy: [{ field: "country" }]
          aggregates: [{ measure: "quality_score" }]
          limit: 5
        ) {
          groupBy { field { name label sqlType isCategorical isPrimaryKey family } }
        }
      }`,
    });

    expect(result.errors).toBeUndefined();
    const payload = result.data!.getAggregates as {
      groupBy: { field: Record<string, unknown> }[];
    };

    expect(payload.groupBy[0].field).toEqual({
      name: 'country',
      label: 'Country',
      sqlType: 'VARCHAR',
      isCategorical: true,
      isPrimaryKey: true,
      family: 'Géographie',
    });
  });
});
