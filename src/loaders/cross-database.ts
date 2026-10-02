// Importation des modules
import { GraphQLError } from 'graphql';
import { FactQueryLoader } from './base-loader.js';
import { databaseManager } from '../db/index.js';
import { assertSchemaSupported } from '../db/schema-version.js';
import { config } from '../utils/config-loader.js';
import { qualifiedTable, quoteIdent } from '../utils/identifiers.js';
import {
  buildAggregateSelect,
  buildOutputOrderBy,
  labelColumnOf,
  paginationBound,
} from '../utils/aggregate-query.js';
import type { Json } from '@duckdb/node-api';
import type { CacheNamespace, DuckDBConnection, SortItem } from './base-loader.js';
import type { Aggregation } from '../generated/graphql.js';
import type { ColumnExtent } from '../db/json-conversion.js';
import type { ResolvedAggregate, ResolvedGroup, ResolvedSort } from '../utils/aggregate-query.js';

// ─── Interfaces des paramètres de requêtes cross-database ─────────────────────

/** Parameters for comparing a measure between two catalogs/schemas. */
interface CompareFactsParams {
  catalogA: string;
  catalogB: string;
  /** Schema within catalogA. Null/undefined uses the catalog's default schema. */
  schemaA?: string | null;
  /** Schema within catalogB. Null/undefined uses the catalog's default schema. */
  schemaB?: string | null;
  joinFields: string[];
  /** Compared measure, checked against the metadata of both sides by the resolver. */
  measure: string;
  /** Aggregation of the measure per key, the same on both sides (resolved by the resolver). */
  aggregation: Aggregation;
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

/** Groups and aggregates of one side of an aggregate comparison, resolved. */
interface ComparisonSide {
  groups: ResolvedGroup[];
  aggregates: ResolvedAggregate[];
}

/** Parameters for comparing aggregates between two catalogs/schemas. */
interface CompareAggregatedFactsParams {
  catalogA: string;
  catalogB: string;
  schemaA?: string | null;
  schemaB?: string | null;
  /** Resolved against the metadata of side A (same fields, aliases and aggregations as B). */
  sideA: ComparisonSide;
  /** Resolved against the metadata of side B (its own label columns). */
  sideB: ComparisonSide;
  /** Sort on output columns, tie-broken by every group column. */
  sort: ResolvedSort[];
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

/** Paginated result of compareFacts. */
interface ComparisonResult {
  data: ComparisonRow[];
  total: number;
  hasNextPage: boolean;
  currentPage: number;
  totalPages: number;
}

/** One page of an aggregate comparison, rows as objects. */
interface AggregateComparisonPage {
  /** Output columns, in SELECT order: groups, labels, then <alias>_a/_b/_delta/_delta_pct. */
  columns: string[];
  /** DuckDB types of the columns, same order. */
  columnTypes: string[];
  /** Rows, serialized by the single JSON converter (NULL preserved). */
  data: Record<string, Json>[];
  /** [min, max] of the numeric and temporal columns of the page, keyed by column. */
  extents: Record<string, ColumnExtent>;
  /** Number of groups common to both sides. */
  total: number;
}

// Alias interne de la mesure comparée par compareFacts dans le SELECT de chaque côté
const MEASURE_ALIAS = '_compared_value';

/** Suffixes of the four output columns of a compared aggregate. */
const COMPARISON_SUFFIXES = ['_a', '_b', '_delta', '_delta_pct'] as const;

/**
 * Output columns of a compared aggregate, in order.
 *
 * @param alias - Alias of the aggregate.
 * @returns `<alias>_a`, `<alias>_b`, `<alias>_delta`, `<alias>_delta_pct`.
 */
// Colonnes de sortie d'un agrégat comparé
function comparedColumnsOf(alias: string): string[] {
  return COMPARISON_SUFFIXES.map((suffix) => `${alias}${suffix}`);
}

/**
 * Builds the label expression of a group column from the label columns
 * available on each side.
 *
 * @param field - Group column.
 * @param labelFieldA - Label column of the field on side A, or null.
 * @param labelFieldB - Label column of the field on side B, or null.
 * @returns `COALESCE(a.<field>__label, b.<field>__label)` over the sides that
 *   have one, or null when neither side has a label column.
 */
// Expression du libellé d'une colonne de groupe : COALESCE des côtés dotés de libellés
function labelExpression(
  field: string,
  labelFieldA: string | null,
  labelFieldB: string | null,
): string | null {
  const column = quoteIdent(labelColumnOf(field));
  const sides = [labelFieldA ? `a.${column}` : null, labelFieldB ? `b.${column}` : null].filter(
    (side): side is string => side !== null,
  );
  return sides.length > 0 ? `COALESCE(${sides.join(', ')})` : null;
}

/**
 * Builds the delta and delta% expressions of a measure present on both sides.
 *
 * @param column - Quoted column name of the measure in each side's SELECT.
 * @returns B - A, and (B - A) / A * 100, NULL when A is 0 or NULL.
 */
// Écart absolu et relatif entre les deux côtés
function deltaExpressions(column: string): { delta: string; deltaPercent: string } {
  return {
    delta: `b.${column} - a.${column}`,
    deltaPercent:
      `CASE WHEN a.${column} IS NOT NULL AND a.${column} != 0 ` +
      `THEN (b.${column} - a.${column}) / a.${column} * 100.0 END`,
  };
}

/**
 * Builds the condition joining both sides on their group columns.
 *
 * Values are compared as VARCHAR so that two catalogs typing the same column
 * differently still align; `nullSafe` makes the NULL groups match each other.
 *
 * @param fields - Group columns.
 * @param nullSafe - Whether NULL matches NULL (IS NOT DISTINCT FROM).
 * @returns The FROM clause joining `a` and `b` (a cross join of two single
 *   rows without group column).
 */
// Jointure a↔b sur les colonnes de groupe, alignées en VARCHAR
function joinClause(fields: readonly string[], nullSafe: boolean): string {
  if (fields.length === 0) return 'FROM a CROSS JOIN b';
  const operator = nullSafe ? 'IS NOT DISTINCT FROM' : '=';
  const condition = fields
    .map((field) => {
      const column = quoteIdent(field);
      return `CAST(a.${column} AS VARCHAR) ${operator} CAST(b.${column} AS VARCHAR)`;
    })
    .join(' AND ');
  return `FROM a JOIN b ON ${condition}`;
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
  /** Value cast to VARCHAR. */
  value: string;
  /** Same as value: the column carries its own label. */
  label: string;
}

// Classe de chargement des requêtes cross-database
/**
 * Loader for cross-catalog / cross-schema comparison queries.
 *
 * Compares a measure, or several aggregates, between two datasets (catalog +
 * schema) — each side aggregated by its keys with the SQL of getAggregates
 * before the join, so a key yields one row whatever its number of fact rows —
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
   *
   * @param queryTimeout - Deadline of one batch, aligned on the timeout of the
   *   resolver consuming the loader.
   */
  constructor(queryTimeout: number = config.API.TIMEOUTS.FACT_COMPLEX) {
    super({
      batchSize: 1,
      cachePrefix: 'cross-database',
      cache: true,
      cacheTimeout: config.API.LOADERS.FACT_CACHE_TIMEOUT,
      catalogId: null,
      queryTimeout,
    });
  }

  // Résolution du schéma d'un côté (explicite ou schéma par défaut du catalogue)
  /**
   * Resolves the schema for one side, validating it against the catalog's
   * allow-list (it is quoted when interpolated).
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
    // Garde de version : les loaders cross-catalog ne sont liés à aucun
    // catalogue, chaque cible est donc vérifiée ici, à sa résolution.
    assertSchemaSupported(catalog, resolved);
    return resolved;
  }

  // Extraction des couples (catalog, schema) portés par une clé, quelle que soit sa forme
  /**
   * Resolves every (catalog, schema) target carried by a key, whichever of
   * the three param shapes it has (compareFacts, compareAggregatedFacts, or
   * crossDatabaseSelectOptions). Each pair goes through {@link resolveSchema},
   * which applies the schema-version guard.
   *
   * @param key - DataLoader key (one of the three cross-database param shapes).
   * @returns The resolved (catalog, schema) pairs, in key order.
   */
  private resolveTargets(key: unknown): Array<{ catalog: string; schema: string }> {
    const params = key as Partial<
      CompareFactsParams & CompareAggregatedFactsParams & CrossDatabaseSelectOptionsParams
    >;
    if (Array.isArray(params.catalogs)) {
      return params.catalogs.map((catalog, i) => ({
        catalog,
        schema: this.resolveSchema(catalog, params.schemas?.[i]),
      }));
    }
    const { catalogA, catalogB, schemaA, schemaB } = params as CompareFactsParams;
    return [
      { catalog: catalogA, schema: this.resolveSchema(catalogA, schemaA) },
      { catalog: catalogB, schema: this.resolveSchema(catalogB, schemaB) },
    ];
  }

  // Garde de version appliquée à chaque cible de la clé, avant toute consultation du cache
  /**
   * Applies the schema version guard to every catalog/schema carried by the
   * key. Unlike `catalog.ts`/`dataset-info.ts`, this loader's query methods
   * already call {@link resolveSchema} (which guards); this override exists
   * so the guard also runs on a cache HIT, before a warm entry for a schema
   * withdrawn since can be served.
   *
   * @param key - DataLoader key naming the catalogs/schemas to read.
   */
  override assertKeyAllowed(key: unknown): void {
    this.resolveTargets(key);
  }

  // Segments (catalog, schema) portés par la clé — le loader n'est lié à aucun catalogue
  /**
   * Returns the cache namespace for a cross-database key.
   *
   * There is no single catalog/schema for a comparison or intersection
   * query, so every target is folded into the namespace, `+`-joined in key
   * order — resolved names rather than the base implementation's
   * 'default'/'_' placeholders (this loader has `catalogId: null`).
   *
   * @param key - DataLoader key naming the catalogs/schemas to read.
   * @returns The combined catalog and schema segments.
   */
  override cacheNamespace(key: unknown): CacheNamespace {
    const targets = this.resolveTargets(key);
    return {
      catalog: targets.map((t) => t.catalog).join('+'),
      schema: targets.map((t) => t.schema).join('+'),
    };
  }

  // SELECT d'agrégats d'un côté, produit par le constructeur unique de getAggregates
  /**
   * Builds the aggregate SELECT of one side, without sort nor pagination.
   *
   * @param catalog - Catalog alias for this side.
   * @param schema - Resolved schema for this side.
   * @param side - Group columns and aggregates of this side.
   * @returns The SQL (no bound value: comparisons take no filter).
   */
  private sideSelect(catalog: string, schema: string, side: ComparisonSide): string {
    return buildAggregateSelect(
      { ...side, includeRowCount: false },
      qualifiedTable(catalog, schema, 'fact_table'),
    ).sql;
  }

  // Méthode de comparaison d'une mesure entre deux datasets
  /**
   * Compares a measure between two datasets, one row per join key.
   *
   * Each side is first aggregated by the join fields (buildAggregateSelect,
   * the SQL of getAggregates), so a key occurring on several rows yields one
   * value per side; both sides are then joined on the join fields, cast to
   * VARCHAR to align differing SQL types (a NULL key matches nothing). Returns
   * delta (B - A) and deltaPercent per key, sorted by the client sort then by
   * every join field, so pages never overlap. With a single join field that
   * has a label column, `keyLabel` is read by ANY_VALUE on each side, then
   * merged by COALESCE.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param params - Datasets, join fields, measure, aggregation and pagination.
   * @returns Paginated comparison result with delta values.
   */
  async compareFacts(
    connection: DuckDBConnection,
    params: CompareFactsParams,
  ): Promise<ComparisonResult> {
    const { catalogA, catalogB, joinFields, measure, aggregation, sort = [] } = params;
    const limit = paginationBound('limit', params.limit);
    const offset = paginationBound('offset', params.offset);

    const schemaA = this.resolveSchema(catalogA, params.schemaA);
    const schemaB = this.resolveSchema(catalogB, params.schemaB);

    // Libellés seulement pour un champ de jointure unique (colonnes de jointure
    // et de libellés contrôlées contre metadata par le resolver)
    const single = joinFields.length === 1;
    const labelFieldA = single ? (params.labelFieldA ?? null) : null;
    const labelFieldB = single ? (params.labelFieldB ?? null) : null;

    // Chaque côté agrégé par les champs de jointure : une ligne par clé
    const side = (labelField: string | null, withMeasure: boolean): ComparisonSide => ({
      groups: joinFields.map((field) => ({
        field,
        grain: null,
        truncation: null,
        labelField: withMeasure ? labelField : null,
      })),
      aggregates: withMeasure ? [{ measure, aggregation, alias: MEASURE_ALIAS }] : [],
    });
    const selectA = this.sideSelect(catalogA, schemaA, side(labelFieldA, true));
    const selectB = this.sideSelect(catalogB, schemaB, side(labelFieldB, true));

    // Clé : valeur du champ unique, ou valeurs jointes par '::'
    const keyColumns = joinFields.map((field) => `CAST(a.${quoteIdent(field)} AS VARCHAR)`);
    const keyExpr = single ? keyColumns[0] : `CONCAT(${keyColumns.join(", '::', ")})`;
    const keyLabel = single ? labelExpression(joinFields[0], labelFieldA, labelFieldB) : null;
    const value = quoteIdent(MEASURE_ALIAS);
    const { delta, deltaPercent } = deltaExpressions(value);

    // Tri client puis départage par chaque champ de jointure : ordre total
    const tieBreak = joinFields.map((_, i) => `_k_${i} ASC`);
    const clientSort = this.buildSortClause(sort).replace(/^ORDER BY /, '');
    const orderBy = `ORDER BY ${[clientSort, ...tieBreak].filter(Boolean).join(', ')}`;

    const query = `
            WITH a AS (${selectA}),
                 b AS (${selectB})
            SELECT key, keyLabel, valueA, valueB, delta, deltaPercent FROM (
                SELECT
                    ${keyExpr} AS key,
                    ${keyLabel ?? 'NULL'} AS keyLabel,
                    a.${value} AS valueA,
                    b.${value} AS valueB,
                    ${delta} AS delta,
                    ${deltaPercent} AS deltaPercent,
                    ${keyColumns.map((column, i) => `${column} AS _k_${i}`).join(', ')}
                ${joinClause(joinFields, false)}
            )
            ${orderBy}
            LIMIT ${limit} OFFSET ${offset}
        `;

    // Comptage des clés communes, sur des côtés réduits aux colonnes de jointure
    const countQuery = `
            WITH a AS (${this.sideSelect(catalogA, schemaA, side(null, false))}),
                 b AS (${this.sideSelect(catalogB, schemaB, side(null, false))})
            SELECT COUNT(*) AS total ${joinClause(joinFields, false)}
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
      totalPages: Math.ceil(total / limit),
    };
  }

  // Méthode de comparaison de plusieurs agrégats entre deux datasets
  /**
   * Compares several aggregates between two datasets, one row per group.
   *
   * Each side runs the SELECT of getAggregates (buildAggregateSelect) over its
   * own fact table; both are joined on the group columns, cast to VARCHAR so
   * differing SQL types align, NULL groups matching each other. For each
   * aggregate alias the row holds `<alias>_a`, `<alias>_b`, `<alias>_delta`
   * (B - A) and `<alias>_delta_pct`; the group columns keep the values of
   * side A and each label column is the COALESCE of both sides. Without group
   * columns, the two single rows are cross-joined.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param params - Datasets, resolved sides, sort and pagination.
   * @returns The page, its columns, their types and extents, and the group count.
   */
  async compareAggregatedFacts(
    connection: DuckDBConnection,
    params: CompareAggregatedFactsParams,
  ): Promise<AggregateComparisonPage> {
    // Extraction des parmaètres d'intérêt
    const { catalogA, catalogB, sideA, sideB, sort } = params;
    const limit = paginationBound('limit', params.limit);
    const offset = paginationBound('offset', params.offset);

    const schemaA = this.resolveSchema(catalogA, params.schemaA);
    const schemaB = this.resolveSchema(catalogB, params.schemaB);
    const fields = sideA.groups.map((group) => group.field);

    // Colonnes de sortie : groupes (côté A), libellés, puis quatre colonnes par agrégat
    const projection = [
      ...fields.map((field) => `a.${quoteIdent(field)} AS ${quoteIdent(field)}`),
      ...sideA.groups.flatMap((group, i) => {
        const label = labelExpression(group.field, group.labelField, sideB.groups[i].labelField);
        return label ? [`${label} AS ${quoteIdent(labelColumnOf(group.field))}`] : [];
      }),
      ...sideA.aggregates.flatMap(({ alias }) => {
        const column = quoteIdent(alias);
        const [colA, colB, colDelta, colDeltaPct] = comparedColumnsOf(alias).map(quoteIdent);
        const { delta, deltaPercent } = deltaExpressions(column);
        return [
          `a.${column} AS ${colA}`,
          `b.${column} AS ${colB}`,
          `${delta} AS ${colDelta}`,
          `${deltaPercent} AS ${colDeltaPct}`,
        ];
      }),
    ];
    const join = joinClause(fields, true);

    // Construction de la requête
    const query = `
            WITH a AS (${this.sideSelect(catalogA, schemaA, sideA)}),
                 b AS (${this.sideSelect(catalogB, schemaB, sideB)})
            SELECT * FROM (SELECT ${projection.join(', ')} ${join})
            ${buildOutputOrderBy(sort)}
            LIMIT ${limit} OFFSET ${offset}
        `;

    // Comptage des groupes communs, sur des côtés réduits aux colonnes de groupe
    const groupsOnly = (side: ComparisonSide): ComparisonSide => ({
      groups: side.groups.map((group) => ({ ...group, labelField: null })),
      aggregates: [],
    });
    const countQuery = `
            WITH a AS (${this.sideSelect(catalogA, schemaA, groupsOnly(sideA))}),
                 b AS (${this.sideSelect(catalogB, schemaB, groupsOnly(sideB))})
            SELECT COUNT(*) AS total ${join}
        `;

    const [page, total] = await Promise.all([
      connection.getWithMetadata(query),
      fields.length > 0
        ? connection.all(countQuery).then((rows) => Number(rows[0]?.total ?? 0))
        : Promise.resolve(1),
    ]);

    return {
      columns: page.columns,
      columnTypes: page.columnTypes ?? [],
      data: page.data as Record<string, Json>[],
      extents: page.metadata.extents,
      total,
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
    // Colonne contrôlée contre metadata de chaque cible par le resolver
    const column = quoteIdent(fieldName);

    if (catalogs.length === 0) return [];

    // Résolution + validation des schémas alignés par index sur les catalogues
    const schemas = catalogs.map((cat, i) => this.resolveSchema(cat, params.schemas?.[i]));

    const primaryCat = catalogs[0];
    const primarySchema = schemas[0];
    const others = catalogs.slice(1).map((cat, i) => ({ cat, schema: schemas[i + 1] }));

    // Valeurs distinctes non nulles d'une cible, alignées en VARCHAR
    const distinctOf = (cat: string, schema: string): string =>
      `SELECT DISTINCT CAST(${column} AS VARCHAR) AS value ` +
      `FROM ${qualifiedTable(cat, schema, 'fact_table')} WHERE ${column} IS NOT NULL`;

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
 * @returns DataLoader keyed by CompareAggregatedFactsParams, returning AggregateComparisonPage.
 */
const createCompareAggregatedFacts = () => {
  const loader = new CrossDatabaseLoader(config.API.TIMEOUTS.AGGREGATED_COMPLEX);
  return loader.createLoader<CompareAggregatedFactsParams, AggregateComparisonPage>(
    (connection, params) => loader.compareAggregatedFacts(connection, params),
  );
};

// Fonction de création d'un loader pour les options cross-database
/**
 * Creates a DataLoader for cross-catalog select option intersection queries.
 *
 * @returns DataLoader keyed by CrossDatabaseSelectOptionsParams.
 */
const createCrossDatabaseSelectOptions = () => {
  const loader = new CrossDatabaseLoader(config.API.TIMEOUTS.FACT_SIMPLE);
  return loader.createLoader<CrossDatabaseSelectOptionsParams, CrossDatabaseSelectOption[]>(
    (connection, params) => loader.crossDatabaseSelectOptions(connection, params),
  );
};

export {
  COMPARISON_SUFFIXES,
  comparedColumnsOf,
  createCompareFacts,
  createCompareAggregatedFacts,
  createCrossDatabaseSelectOptions,
  CrossDatabaseLoader,
};
export type {
  CompareFactsParams,
  CompareAggregatedFactsParams,
  ComparisonSide,
  CrossDatabaseSelectOptionsParams,
  ComparisonRow,
  ComparisonResult,
  AggregateComparisonPage,
  CrossDatabaseSelectOption,
};
