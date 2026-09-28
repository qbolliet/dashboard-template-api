// Importation des modules
import { sqlTypeFamily } from './filter-tree.js';
import type { SqlTypeFamily } from './filter-tree.js';
import type { Aggregation } from '../generated/graphql.js';

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Every aggregation of the GraphQL `Aggregation` enum, in its declaration order. */
const AGGREGATIONS: readonly Aggregation[] = [
  'SUM',
  'AVG',
  'MAX',
  'MIN',
  'COUNT',
  'MEDIAN',
  'MODE',
];

// Agrégations admises par famille de type de la mesure ; un type sans famille
// (LIST, BLOB…) n'admet que celles qui valent pour toutes (MODE, COUNT)
const ALLOWED_BY_FAMILY: Record<SqlTypeFamily, readonly Aggregation[]> = {
  numeric: AGGREGATIONS,
  date: ['MAX', 'MIN', 'COUNT', 'MODE'],
  text: ['COUNT', 'MODE'],
  boolean: ['COUNT', 'MODE'],
};
const ALLOWED_WITHOUT_FAMILY: readonly Aggregation[] = ['COUNT', 'MODE'];

// Agrégations dont le résultat est toujours numérique, quel que soit le type de la mesure
const NUMERIC_RESULT: readonly Aggregation[] = ['SUM', 'AVG', 'MEDIAN', 'COUNT'];

// ─── Fonctions ────────────────────────────────────────────────────────────────

/**
 * Type family of a measure, or null when its SQL type has none.
 *
 * @param sqlType - DuckDB type of the measure (metadata.sqlType).
 * @returns The family, or null for a type without family (LIST, BLOB…).
 */
// Famille de type d'une mesure, null hors des quatre familles
function measureFamily(sqlType: string | null | undefined): SqlTypeFamily | null {
  try {
    return sqlTypeFamily(sqlType ?? '');
  } catch {
    return null;
  }
}

/**
 * Aggregations allowed on a measure, by the type family of its SQL type.
 *
 * SUM, AVG and MEDIAN require a numeric measure; MIN and MAX a numeric or
 * temporal one; MODE and COUNT apply to every type.
 *
 * @param sqlType - DuckDB type of the measure (metadata.sqlType).
 * @returns The allowed aggregations, in the enum order.
 */
// Agrégations admises sur une mesure selon sa famille de type
function allowedAggregations(sqlType: string | null | undefined): readonly Aggregation[] {
  const family = measureFamily(sqlType);
  const allowed = family ? ALLOWED_BY_FAMILY[family] : ALLOWED_WITHOUT_FAMILY;
  return AGGREGATIONS.filter((aggregation) => allowed.includes(aggregation));
}

/**
 * Type family of the aggregated value, which drives its extent and statistics.
 *
 * SUM, AVG, MEDIAN and COUNT always yield a number; MIN, MAX and MODE yield a
 * value of the measure itself.
 *
 * @param aggregation - Effective aggregation.
 * @param sqlType - DuckDB type of the measure (metadata.sqlType).
 * @returns The family of the aggregated value, or null when it has none.
 */
// Famille de la valeur agrégée : numérique, ou celle de la mesure
function aggregatedValueFamily(
  aggregation: Aggregation,
  sqlType: string | null | undefined,
): SqlTypeFamily | null {
  return NUMERIC_RESULT.includes(aggregation) ? 'numeric' : measureFamily(sqlType);
}

export { AGGREGATIONS, measureFamily, allowedAggregations, aggregatedValueFamily };
