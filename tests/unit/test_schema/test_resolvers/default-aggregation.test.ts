/**
 * Integration tests for the implicit aggregation of aggregated fact queries.
 *
 * The `aggregation` argument of getAggregatedFacts and
 * getAggregatedFactsWithMetadata is optional and carries no SDL default. When
 * the client omits it, the measure's `metadata.defaultAggregation` applies,
 * and SUM closes the chain for a numeric measure only (revue-technique-api.md
 * §5.1); a non-numeric measure without default is a client error.
 *
 * The fixtures make the distinction observable: `quality_score` declares AVG,
 * `value` declares SUM, `horizon` (INTEGER) and `is_provisional` (BOOLEAN)
 * declare nothing at all.
 */

import { ApolloServer } from '@apollo/server';
import { ensureSetup, getServer, execute } from './helpers.js';

// ─── État partagé ─────────────────────────────────────────────────────────────

// Serveur Apollo réutilisé par tous les tests du fichier
let server: ApolloServer;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
}, 60000);

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

/** One aggregated row as returned by the resolver. */
interface AggregatedRow {
  key: string;
  /** null for a group whose measure is entirely NULL. */
  aggregatedValue: number | null;
  count: number;
}

/**
 * Runs getAggregatedFacts with or without an explicit aggregation.
 *
 * @param measure - Measure column to aggregate.
 * @param aggregation - Explicit aggregation, or null to omit the argument.
 * @returns The aggregated rows, keyed by group value.
 */
// Exécution d'une agrégation, l'argument étant omis quand aggregation est null
const aggregate = async (
  measure: string,
  aggregation: string | null,
): Promise<Map<string, number | null>> => {
  const arg = aggregation === null ? '' : `aggregation: ${aggregation}, `;
  const result = await execute(server, {
    query: `query {
      getAggregatedFacts(
        schema: "main"
        groupBy: "country"
        measure: "${measure}"
        ${arg}limit: 100
      ) { key aggregatedValue count }
    }`,
  });

  expect(result.errors).toBeUndefined();
  const rows = result.data!.getAggregatedFacts as AggregatedRow[];
  return new Map(rows.map((row) => [row.key, row.aggregatedValue]));
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
    const implicit = await aggregate('value', null);
    const sum = await aggregate('value', 'SUM');

    expect(implicit).toEqual(sum);
  });

  test('une mesure numérique sans agrégation déclarée retombe sur SUM', async () => {
    // `horizon` (INTEGER) ne déclare aucune defaultAggregation
    const implicit = await aggregate('horizon', null);
    const sum = await aggregate('horizon', 'SUM');

    expect(implicit).toEqual(sum);
  });

  test('une mesure non numérique sans agrégation déclarée est rejetée (pas de COUNT implicite)', async () => {
    // `is_provisional` (BOOLEAN) ne déclare aucune defaultAggregation
    const result = await execute(server, {
      query: `query {
        getAggregatedFacts(schema: "main", groupBy: "country", measure: "is_provisional") { key }
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
    // null pour les deux agrégations (plus de 0 fictif)
    for (const [key, value] of explicit) {
      if (value === null) {
        expect(implicit.get(key)).toBeNull();
        continue;
      }
      expect(value).toBeGreaterThanOrEqual(implicit.get(key)!);
    }
  });

  test('deux mesures aux défauts différents ne partagent pas leur agrégation', async () => {
    const qualityImplicit = await aggregate('quality_score', null);
    const qualityAsSum = await aggregate('quality_score', 'SUM');

    // Si le défaut n'était pas lu dans la metadata, les deux seraient égaux
    expect(qualityImplicit).not.toEqual(qualityAsSum);
  });

  test('getAggregatedFactsWithMetadata applique le même défaut', async () => {
    /**
     * Runs the metadata variant and returns its value extent.
     *
     * @param aggregation - Explicit aggregation, or null to omit it.
     * @returns The [min, max] extent of the aggregated values.
     */
    // Extent des valeurs agrégées, comparable entre deux exécutions
    const extentFor = async (aggregation: string | null): Promise<number[]> => {
      const arg = aggregation === null ? '' : `aggregation: ${aggregation}, `;
      const result = await execute(server, {
        query: `query {
          getAggregatedFactsWithMetadata(
            schema: "main"
            groupBy: "country"
            measure: "quality_score"
            ${arg}limit: 100
          ) { metadata { valueExtent } }
        }`,
      });
      expect(result.errors).toBeUndefined();
      const payload = result.data!.getAggregatedFactsWithMetadata as {
        metadata: { valueExtent: number[] };
      };
      return payload.metadata.valueExtent;
    };

    expect(await extentFor(null)).toEqual(await extentFor('AVG'));
    expect(await extentFor(null)).not.toEqual(await extentFor('SUM'));
  });

  test('groupByFieldInfo remonte la métadonnée en camelCase', async () => {
    const result = await execute(server, {
      query: `query {
        getAggregatedFactsWithMetadata(
          schema: "main"
          groupBy: "country"
          measure: "quality_score"
          limit: 5
        ) {
          metadata {
            groupByFieldInfo { name label sqlType isCategorical isPrimaryKey family }
          }
        }
      }`,
    });

    expect(result.errors).toBeUndefined();
    const payload = result.data!.getAggregatedFactsWithMetadata as {
      metadata: { groupByFieldInfo: Record<string, unknown> };
    };

    expect(payload.metadata.groupByFieldInfo).toEqual({
      name: 'country',
      label: 'Country',
      sqlType: 'VARCHAR',
      isCategorical: true,
      isPrimaryKey: true,
      family: 'Géographie',
    });
  });
});
