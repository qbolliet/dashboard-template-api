// Importation des modules
import { GraphQLError } from 'graphql';
import { FactQueryLoader } from './base-loader.js';
import { databaseManager } from '../db/index.js';
import { assertSchemaSupported } from '../db/schema-version.js';
import { config } from '../utils/config-loader.js';
import { AggregatedFactsLoader } from './aggregated-facts.js';
import { validateIdentifier } from '../utils/utils.js';
import type { DuckDBConnection, SortItem } from './base-loader.js';
import type { AggregationType } from './aggregated-facts.js';

// ─── Interfaces des paramètres de requêtes cross-database ─────────────────────

/** Parameters for comparing the fact table between two catalogs/schemas. */
interface CompareFactsParams {
  catalogA: string;
  catalogB: string;
  /** Schema within catalogA. Null/undefined uses the catalog's default schema. */
  schemaA?: string | null;
  /** Schema within catalogB. Null/undefined uses the catalog's default schema. */
  schemaB?: string | null;
  joinFields: string[];
  /**
   * Effective label columns of the single join field on each side, resolved by
   * resolveLabelField (null: none, or several join fields). Part of the key.
   */
  labelFieldA?: string | null;
  labelFieldB?: string | null;
  limit: number;
  offset: number;
  sort?: SortItem[];
}

/** Parameters for comparing aggregated facts between two catalogs/schemas. */
interface CompareAggregatedFactsParams {
  catalogA: string;
  catalogB: string;
  schemaA?: string | null;
  schemaB?: string | null;
  groupBy: string;
  aggregation?: AggregationType;
  /** Effective label columns of groupBy on each side (null: none). Part of the key. */
  labelFieldA?: string | null;
  labelFieldB?: string | null;
  limit: number;
  offset: number;
}

/** Parameters for cross-catalog select option intersection queries. */
interface CrossDatabaseSelectOptionsParams {
  fieldName: string;
  catalogs: string[];
  /** Schemas aligned by index with `catalogs`. Missing entries use the default. */
  schemas?: (string | null)[];
  limit: number;
}

// ─── Interfaces des résultats ─────────────────────────────────────────────────

/** Comparison row between two catalogs (delta and delta%). */
interface ComparisonRow {
  key: string;
  /** Label of the key, COALESCE of both sides; null without label column. */
  keyLabel: string | null;
  valueA: number | null;
  valueB: number | null;
  delta: number | null;
  deltaPercent: number | null;
}

/** Paginated result of a cross-catalog comparison. */
interface ComparisonResult {
  data: ComparisonRow[];
  total: number;
  hasNextPage: boolean;
  currentPage: number;
  totalPages: number;
}

// Alias interne du libellé de la clé dans les CTE de chaque côté
const KEY_LABEL_ALIAS = '_key_label';

/**
 * Builds the keyLabel expression from the label columns available on each side.
 *
 * @param labelFieldA - Label column on side A, or null.
 * @param labelFieldB - Label column on side B, or null.
 * @returns `COALESCE(a._key_label, b._key_label)` over the sides that have one,
 *   or `NULL` when neither side has a label column.
 */
// Expression du libellé de la clé : COALESCE des côtés dotés de libellés
function keyLabelExpression(labelFieldA: string | null, labelFieldB: string | null): string {
  const sides = [
    labelFieldA ? `a.${KEY_LABEL_ALIAS}` : null,
    labelFieldB ? `b.${KEY_LABEL_ALIAS}` : null,
  ].filter((side): side is string => side !== null);
  return sides.length > 0 ? `COALESCE(${sides.join(', ')})` : 'NULL';
}

/**
 * Converts a raw comparison row into its typed form.
 *
 * @param row - Raw row with key, keyLabel, valueA, valueB, delta, deltaPercent.
 * @returns The typed comparison row.
 */
// Mise en forme d'une ligne de comparaison
function toComparisonRow(row: Record<string, unknown>): ComparisonRow {
  return {
    key: String(row.key),
    keyLabel: row.keyLabel != null ? String(row.keyLabel) : null,
    valueA: row.valueA != null ? Number(row.valueA) : null,
    valueB: row.valueB != null ? Number(row.valueB) : null,
    delta: row.delta != null ? Number(row.delta) : null,
    deltaPercent: row.deltaPercent != null ? Number(row.deltaPercent) : null,
  };
}

/** Select option from a cross-catalog query. */
interface CrossDatabaseSelectOption {
  value: unknown;
  label?: unknown;
}

// Classe de chargement des requêtes cross-database
/**
 * Loader for cross-catalog / cross-schema comparison queries.
 *
 * Compares fact and aggregated fact data between two datasets (catalog + schema),
 * and computes the intersection of select options across multiple datasets.
 *
 * The fact table stores labels directly (no dim_* table exists), so a column
 * carries the same meaning in every dataset and joining on it is correct by
 * construction. Join keys are nonetheless compared as VARCHAR: two catalogs may
 * type the same column differently, and the cast aligns them.
 */
class CrossDatabaseLoader extends FactQueryLoader {
  // Initialisation sans identifiant de catalogue (requêtes cross-catalog)
  /**
   * Creates a CrossDatabaseLoader with no specific catalog binding.
   *
   * Catalog/schema identifiers are passed through the query params at load time.
   */
  constructor() {
    super({
      batchSize: 1,
      cachePrefix: 'cross-database',
      cache: true,
      cacheTimeout: config.API.LOADERS.FACT_CACHE_TIMEOUT,
      catalogId: null,
    });
  }

  // Résolution du schéma d'un côté (explicite ou schéma par défaut du catalogue)
  /**
   * Resolves the schema for one side, validating it both against the catalog's
   * allow-list and as a SQL identifier.
   *
   * @param catalog - Catalog alias.
   * @param schema - Explicit schema, or null/undefined for the catalog default.
   * @returns Validated schema name.
   * @throws {GraphQLError} When the schema is not configured for the catalog.
   */
  private resolveSchema(catalog: string, schema?: string | null): string {
    const resolved = schema || databaseManager.getDefaultSchema(catalog);
    if (!databaseManager.isValidSchema(catalog, resolved)) {
      throw new GraphQLError(
        `Schema '${resolved}' is not available for catalog '${catalog}'. ` +
          `Available: ${databaseManager.getSchemas(catalog).join(', ')}`,
      );
    }
    validateIdentifier(resolved, 'schema');
    // Garde de version : les loaders cross-catalog ne sont liés à aucun
    // catalogue, chaque cible est donc vérifiée ici, à sa résolution.
    assertSchemaSupported(catalog, resolved);
    return resolved;
  }

  // Validation d'une colonne de libellés avant interpolation
  /**
   * Validates an optional label column name before SQL interpolation.
   *
   * @param labelField - Label column resolved by the resolver, or null/undefined.
   * @returns The validated name, or null.
   */
  private validateLabelField(labelField?: string | null): string | null {
    return labelField ? validateIdentifier(labelField, 'labelField') : null;
  }

  // Construction du SELECT d'un côté : mesure + colonnes de jointure alignées
  /**
   * Builds the per-side SELECT that exposes the measure plus one key column per
   * join field, cast to VARCHAR so both sides align whatever their SQL type.
   *
   * @param catalog - Catalog alias for this side.
   * @param schema - Resolved schema for this side.
   * @param joinFields - Fields participating in the join.
   * @param labelField - Label column of the single join field on this side, or null.
   * @returns A SQL SELECT statement (no trailing semicolon).
   */
  private buildSideSelect(
    catalog: string,
    schema: string,
    joinFields: string[],
    labelField: string | null,
  ): string {
    const keyCols = joinFields.map((f) => `CAST(f.${f} AS VARCHAR) AS k_${f}`);
    // Libellé de la clé lu dans la même ligne que le code
    if (labelField) keyCols.push(`f.${labelField} AS ${KEY_LABEL_ALIAS}`);
    return `SELECT f.value AS value, ${keyCols.join(', ')} FROM "${catalog}".${schema}.fact_table f`;
  }

  // Méthode de comparaison des tables de faits entre deux datasets
  /**
   * Compares fact table rows between two datasets via a JOIN on shared fields.
   *
   * Join fields are matched directly on their stored values — the fact table
   * carries the labels — cast to VARCHAR to align differing SQL types. Returns
   * delta (B - A) and deltaPercent per row, with pagination metadata. With a
   * single join field that has a label column, `keyLabel` is read in the same
   * query, COALESCE of both sides.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param params - Parameters defining the two datasets, join fields, and pagination.
   * @returns Paginated comparison result with delta values.
   */
  async compareFacts(
    connection: DuckDBConnection,
    params: CompareFactsParams,
  ): Promise<ComparisonResult> {
    const { catalogA, catalogB, joinFields, limit, offset, sort = [] } = params;

    const schemaA = this.resolveSchema(catalogA, params.schemaA);
    const schemaB = this.resolveSchema(catalogB, params.schemaB);

    // Validation des identifiants de jointure pour éviter les injections SQL
    joinFields.forEach((f) => validateIdentifier(f, 'joinField'));

    // Libellés seulement pour un champ de jointure unique
    const single = joinFields.length === 1;
    const labelFieldA = single ? this.validateLabelField(params.labelFieldA) : null;
    const labelFieldB = single ? this.validateLabelField(params.labelFieldB) : null;

    const selectA = this.buildSideSelect(catalogA, schemaA, joinFields, labelFieldA);
    const selectB = this.buildSideSelect(catalogB, schemaB, joinFields, labelFieldB);

    // Condition de jointure a↔b sur les libellés portés par les colonnes
    const joinCondition = joinFields.map((f) => `a.k_${f} = b.k_${f}`).join(' AND ');

    // Expression de la clé principale dans le résultat
    const keyExpr =
      joinFields.length === 1
        ? `a.k_${joinFields[0]}`
        : `CONCAT(${joinFields.map((f) => `a.k_${f}`).join(", '::', ")})`;

    // Tri déterministe : sans tri explicite, la clé de jointure ordonne le
    // résultat. Les colonnes de cluster_by ne survivent pas aux CTE (seules
    // key/valueA/valueB/delta/deltaPercent sont projetées), et `key` est
    // construite depuis les joinFields.
    const sortClause = sort.length > 0 ? this.buildSortClause(sort) : 'ORDER BY key ASC';

    const query = `
            WITH a AS (${selectA}),
                 b AS (${selectB})
            SELECT
                ${keyExpr} AS key,
                ${keyLabelExpression(labelFieldA, labelFieldB)} AS keyLabel,
                a.value AS valueA,
                b.value AS valueB,
                b.value - a.value AS delta,
                CASE WHEN a.value IS NOT NULL AND a.value != 0
                    THEN (b.value - a.value) / a.value * 100.0
                END AS deltaPercent
            FROM a JOIN b ON ${joinCondition}
            ${sortClause}
            LIMIT ${limit} OFFSET ${offset}
        `;

    // Comptage total pour le calcul de la pagination
    const countQuery = `
            WITH a AS (${selectA}),
                 b AS (${selectB})
            SELECT COUNT(*) AS total
            FROM a JOIN b ON ${joinCondition}
        `;

    const [results, countResult] = await Promise.all([
      connection.all(query),
      connection.all(countQuery),
    ]);
    const total = Number(countResult[0]?.total ?? 0);

    return {
      data: results.map(toComparisonRow),
      total,
      hasNextPage: offset + limit < total,
      currentPage: Math.floor(offset / limit) + 1,
      totalPages: limit > 0 ? Math.ceil(total / limit) : 1,
    };
  }

  // Méthode de comparaison des faits agrégés entre deux datasets
  /**
   * Compares aggregated fact values between two datasets.
   *
   * Each side is aggregated by its own groupBy column — which carries the label
   * — then the two results are joined on that key, cast to VARCHAR so differing
   * SQL types align. Uses CTEs to pre-aggregate, avoiding Cartesian products.
   * The label of the key is read by `ANY_VALUE` in each side's aggregation —
   * the same path as getAggregatedFacts — then merged by COALESCE.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param params - Parameters defining datasets, groupBy, aggregation, and pagination.
   * @returns Paginated comparison result with aggregated delta values.
   */
  async compareAggregatedFacts(
    connection: DuckDBConnection,
    params: CompareAggregatedFactsParams,
  ): Promise<ComparisonResult> {
    const { catalogA, catalogB, groupBy, aggregation = 'SUM', limit, offset } = params;

    const schemaA = this.resolveSchema(catalogA, params.schemaA);
    const schemaB = this.resolveSchema(catalogB, params.schemaB);

    validateIdentifier(groupBy, 'groupBy');
    const labelFieldA = this.validateLabelField(params.labelFieldA);
    const labelFieldB = this.validateLabelField(params.labelFieldB);
    const aggFn = AggregatedFactsLoader.AGGREGATION_MAP[aggregation as AggregationType] || 'SUM';

    // CTE d'agrégation per-side : regroupement direct sur la colonne, libellé par ANY_VALUE
    const aggSide = (catalog: string, schema: string, labelField: string | null): string =>
      `SELECT CAST(${groupBy} AS VARCHAR) AS key,
              ${labelField ? `ANY_VALUE(${labelField}) AS ${KEY_LABEL_ALIAS},` : ''}
              ${aggFn}(value) AS value
       FROM "${catalog}".${schema}.fact_table
       GROUP BY ${groupBy}`;

    const query = `
            WITH agg_a AS (${aggSide(catalogA, schemaA, labelFieldA)}),
                 agg_b AS (${aggSide(catalogB, schemaB, labelFieldB)})
            SELECT
                a.key,
                ${keyLabelExpression(labelFieldA, labelFieldB)} AS keyLabel,
                a.value AS valueA,
                b.value AS valueB,
                b.value - a.value AS delta,
                CASE WHEN a.value IS NOT NULL AND a.value != 0
                    THEN (b.value - a.value) / a.value * 100.0
                END AS deltaPercent
            FROM agg_a a
            JOIN agg_b b ON a.key = b.key
            ORDER BY a.key ASC
            LIMIT ${limit} OFFSET ${offset}
        `;

    // Comptage total des clés communes pour la pagination
    const countQuery = `
            WITH agg_a AS (${aggSide(catalogA, schemaA, null)}),
                 agg_b AS (${aggSide(catalogB, schemaB, null)})
            SELECT COUNT(*) AS total FROM agg_a a JOIN agg_b b ON a.key = b.key
        `;

    const [results, countResult] = await Promise.all([
      connection.all(query),
      connection.all(countQuery),
    ]);
    const total = Number(countResult[0]?.total ?? 0);

    return {
      data: results.map(toComparisonRow),
      total,
      hasNextPage: offset + limit < total,
      currentPage: Math.floor(offset / limit) + 1,
      totalPages: limit > 0 ? Math.ceil(total / limit) : 1,
    };
  }

  // Méthode de calcul de l'intersection des options de sélection entre datasets
  /**
   * Computes the intersection of select options across multiple datasets.
   *
   * Every column carries its own labels, so the intersection is a plain
   * INTERSECT of the DISTINCT values of each target, cast to VARCHAR to align
   * differing SQL types. `label = value`, as everywhere else.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param params - Parameters defining the field, catalog/schema list, and limit.
   * @returns Array of options present in all provided datasets.
   */
  async crossDatabaseSelectOptions(
    connection: DuckDBConnection,
    params: CrossDatabaseSelectOptionsParams,
  ): Promise<CrossDatabaseSelectOption[]> {
    const { fieldName, catalogs, limit } = params;
    validateIdentifier(fieldName, 'fieldName');

    if (catalogs.length === 0) return [];

    // Résolution + validation des schémas alignés par index sur les catalogues
    const schemas = catalogs.map((cat, i) => this.resolveSchema(cat, params.schemas?.[i]));

    const primaryCat = catalogs[0];
    const primarySchema = schemas[0];
    const others = catalogs.slice(1).map((cat, i) => ({ cat, schema: schemas[i + 1] }));

    // Valeurs distinctes non nulles d'une cible, alignées en VARCHAR
    const distinctOf = (cat: string, schema: string): string =>
      `SELECT DISTINCT CAST(${fieldName} AS VARCHAR) AS value ` +
      `FROM "${cat}".${schema}.fact_table WHERE ${fieldName} IS NOT NULL`;

    let query = `SELECT value, value AS label FROM (${distinctOf(primaryCat, primarySchema)})`;
    if (others.length > 0) {
      const intersection = others
        .map(({ cat, schema }) => distinctOf(cat, schema))
        .join(' INTERSECT ');
      query += ` WHERE value IN (${intersection})`;
    }
    query += ` ORDER BY value LIMIT ${limit}`;

    // Les colonnes value et label sont sélectionnées explicitement dans la requête
    const rows = await connection.all(query);
    return rows as unknown as CrossDatabaseSelectOption[];
  }
}

// Fonction de création d'un loader pour la comparaison des faits entre datasets
/**
 * Creates a DataLoader for fact table comparison between two datasets.
 *
 * @returns DataLoader keyed by CompareFactsParams, returning ComparisonResult.
 */
const createCompareFacts = () => {
  const loader = new CrossDatabaseLoader();
  return loader.createLoader<CompareFactsParams, ComparisonResult>((connection, params) =>
    loader.compareFacts(connection, params),
  );
};

// Fonction de création d'un loader pour la comparaison des faits agrégés
/**
 * Creates a DataLoader for aggregated fact comparison between two datasets.
 *
 * @returns DataLoader keyed by CompareAggregatedFactsParams, returning ComparisonResult.
 */
const createCompareAggregatedFacts = () => {
  const loader = new CrossDatabaseLoader();
  return loader.createLoader<CompareAggregatedFactsParams, ComparisonResult>((connection, params) =>
    loader.compareAggregatedFacts(connection, params),
  );
};

// Fonction de création d'un loader pour les options cross-database
/**
 * Creates a DataLoader for cross-catalog select option intersection queries.
 *
 * @returns DataLoader keyed by CrossDatabaseSelectOptionsParams.
 */
const createCrossDatabaseSelectOptions = () => {
  const loader = new CrossDatabaseLoader();
  return loader.createLoader<CrossDatabaseSelectOptionsParams, CrossDatabaseSelectOption[]>(
    (connection, params) => loader.crossDatabaseSelectOptions(connection, params),
  );
};

export {
  createCompareFacts,
  createCompareAggregatedFacts,
  createCrossDatabaseSelectOptions,
  CrossDatabaseLoader,
};
export type {
  CompareFactsParams,
  CompareAggregatedFactsParams,
  CrossDatabaseSelectOptionsParams,
  ComparisonRow,
  ComparisonResult,
  CrossDatabaseSelectOption,
};
