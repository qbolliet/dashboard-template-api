// Importation des modules
import { GraphQLError } from 'graphql';
import { BaseQueryLoader } from './base-loader.js';
import { databaseManager } from '../db/index.js';
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
 * IMPORTANT — correctness: categorical columns in the fact table store an integer
 * ID whose meaning is local to each catalog/schema (it depends on the order in
 * which modalities were ingested). The same ID can therefore denote different
 * modalities across datasets. All cross-dataset matching here resolves IDs to
 * their human-readable labels via the dim_* tables BEFORE joining, never on the
 * raw ID. Continuous (non-categorical) columns carry the same meaning across
 * datasets and are matched directly.
 */
class CrossDatabaseLoader extends BaseQueryLoader {
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
    return resolved;
  }

  // Détermination des champs catégoriels via la table metadata d'un dataset
  /**
   * Builds a map fieldName → is_categorical for the given fields of a dataset.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param catalog - Catalog alias.
   * @param schema - Resolved schema name.
   * @param fields - Field names to look up.
   * @returns Record mapping each found field to its categorical flag.
   */
  private async getCategoricalMap(
    connection: DuckDBConnection,
    catalog: string,
    schema: string,
    fields: string[],
  ): Promise<Record<string, boolean>> {
    if (fields.length === 0) return {};
    const placeholders = fields.map(() => '?').join(',');
    const rows = await connection.all(
      `SELECT name, is_categorical FROM "${catalog}".${schema}.metadata WHERE name IN (${placeholders})`,
      fields,
    );
    const map: Record<string, boolean> = {};
    rows.forEach((r) => {
      map[String(r.name)] = Boolean(r.is_categorical);
    });
    return map;
  }

  // Construction du SELECT d'un côté : valeur mesurée + clés résolues en labels
  /**
   * Builds the per-side SELECT that exposes the measure plus one key column per
   * join field — the dim label for categorical fields, the raw value otherwise.
   *
   * @param catalog - Catalog alias for this side.
   * @param schema - Resolved schema for this side.
   * @param dimPrefix - Alias prefix to disambiguate dim joins (e.g. 'da'/'db').
   * @param joinFields - Fields participating in the join.
   * @param catMap - Categorical flags for this side's fields.
   * @returns A SQL SELECT statement (no trailing semicolon).
   */
  private buildSideSelect(
    catalog: string,
    schema: string,
    dimPrefix: string,
    joinFields: string[],
    catMap: Record<string, boolean>,
  ): string {
    const dimJoins: string[] = [];
    const keyCols: string[] = [];
    for (const f of joinFields) {
      if (catMap[f]) {
        // Champ catégoriel : on joint la table de dimension et on expose le label
        const d = `${dimPrefix}_${f}`;
        dimJoins.push(`JOIN "${catalog}".${schema}.dim_${f} ${d} ON f.${f} = ${d}.value`);
        keyCols.push(`${d}.label AS k_${f}`);
      } else {
        // Champ continu : même sens d'un dataset à l'autre, valeur brute exposée
        keyCols.push(`f.${f} AS k_${f}`);
      }
    }
    return (
      `SELECT f.value AS value, ${keyCols.join(', ')} ` +
      `FROM "${catalog}".${schema}.fact_table f ${dimJoins.join(' ')}`
    );
  }

  // Méthode de comparaison des tables de faits entre deux datasets
  /**
   * Compares fact table rows between two datasets via a JOIN on shared fields.
   *
   * Categorical join fields are matched on their dim_* labels (never the raw ID);
   * continuous fields are matched directly. Returns delta (B - A) and deltaPercent
   * per row, with pagination metadata.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param params - Parameters defining the two datasets, join fields, and pagination.
   * @returns Paginated comparison result with delta values.
   * @throws {Error} When a join field is categorical on one side only.
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
    // Validation des champs de tri (interpolés dans ORDER BY)
    sort.forEach((s) => validateIdentifier(s.field, 'sortField'));

    // Détermination des champs catégoriels de chaque côté
    const [catMapA, catMapB] = await Promise.all([
      this.getCategoricalMap(connection, catalogA, schemaA, joinFields),
      this.getCategoricalMap(connection, catalogB, schemaB, joinFields),
    ]);

    const selectA = this.buildSideSelect(catalogA, schemaA, 'da', joinFields, catMapA);
    const selectB = this.buildSideSelect(catalogB, schemaB, 'db', joinFields, catMapB);

    // Condition de jointure a↔b sur les labels (catégoriels) / valeurs (continus)
    const joinCondition = joinFields.map((f) => `a.k_${f} = b.k_${f}`).join(' AND ');

    // Expression de la clé principale dans le résultat (labels résolus)
    const keyExpr =
      joinFields.length === 1
        ? `a.k_${joinFields[0]}`
        : `CONCAT(${joinFields.map((f) => `CAST(a.k_${f} AS VARCHAR)`).join(", '::', ")})`;

    const sortClause =
      sort.length > 0 ? `ORDER BY ${sort.map((s) => `${s.field} ${s.order}`).join(', ')}` : '';

    const query = `
            WITH a AS (${selectA}),
                 b AS (${selectB})
            SELECT
                ${keyExpr} AS key,
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
      data: results.map((row) => ({
        key: String(row.key),
        valueA: row.valueA != null ? Number(row.valueA) : null,
        valueB: row.valueB != null ? Number(row.valueB) : null,
        delta: row.delta != null ? Number(row.delta) : null,
        deltaPercent: row.deltaPercent != null ? Number(row.deltaPercent) : null,
      })),
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
   * When groupBy is categorical, each side is aggregated by the dim_* label
   * (never the raw ID) before joining on the label. Continuous groupBy keys are
   * aggregated directly. Uses CTEs to pre-aggregate, avoiding Cartesian products.
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
    const aggFn = AggregatedFactsLoader.AGGREGATION_MAP[aggregation as AggregationType] || 'SUM';

    // Détermination du caractère catégoriel du champ de regroupement de chaque côté
    const [catMapA, catMapB] = await Promise.all([
      this.getCategoricalMap(connection, catalogA, schemaA, [groupBy]),
      this.getCategoricalMap(connection, catalogB, schemaB, [groupBy]),
    ]);
    // CTE d'agrégation per-side : label si catégoriel dans ce schéma, valeur brute sinon
    const aggSide = (catalog: string, schema: string, isCat: boolean): string =>
      isCat
        ? `SELECT d.label AS key, ${aggFn}(f.value) AS value
           FROM "${catalog}".${schema}.fact_table f
           JOIN "${catalog}".${schema}.dim_${groupBy} d ON f.${groupBy} = d.value
           GROUP BY d.label`
        : `SELECT ${groupBy} AS key, ${aggFn}(value) AS value
           FROM "${catalog}".${schema}.fact_table
           GROUP BY ${groupBy}`;

    const query = `
            WITH agg_a AS (${aggSide(catalogA, schemaA, Boolean(catMapA[groupBy]))}),
                 agg_b AS (${aggSide(catalogB, schemaB, Boolean(catMapB[groupBy]))})
            SELECT
                a.key,
                a.value AS valueA,
                b.value AS valueB,
                b.value - a.value AS delta,
                CASE WHEN a.value IS NOT NULL AND a.value != 0
                    THEN (b.value - a.value) / a.value * 100.0
                END AS deltaPercent
            FROM agg_a a
            JOIN agg_b b ON a.key = b.key
            LIMIT ${limit} OFFSET ${offset}
        `;

    // Comptage total des clés communes pour la pagination
    const countQuery = `
            WITH agg_a AS (${aggSide(catalogA, schemaA, Boolean(catMapA[groupBy]))}),
                 agg_b AS (${aggSide(catalogB, schemaB, Boolean(catMapB[groupBy]))})
            SELECT COUNT(*) AS total FROM agg_a a JOIN agg_b b ON a.key = b.key
        `;

    const [results, countResult] = await Promise.all([
      connection.all(query),
      connection.all(countQuery),
    ]);
    const total = Number(countResult[0]?.total ?? 0);

    return {
      data: results.map((row) => ({
        key: String(row.key),
        valueA: row.valueA != null ? Number(row.valueA) : null,
        valueB: row.valueB != null ? Number(row.valueB) : null,
        delta: row.delta != null ? Number(row.delta) : null,
        deltaPercent: row.deltaPercent != null ? Number(row.deltaPercent) : null,
      })),
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
   * For categorical fields the intersection is computed on the dim_* labels
   * (the raw IDs are not comparable across datasets); the returned value is the
   * primary dataset's ID and the label is the shared modality. For continuous
   * fields the raw values are comparable and are intersected directly.
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

    // Détermination du type du champ via les méta-données du premier dataset
    const metaQuery = `SELECT is_categorical FROM "${primaryCat}".${primarySchema}.metadata WHERE name = ?`;
    const metaResult = await connection.all(metaQuery, [fieldName]);
    const isCategorical = metaResult[0]?.is_categorical;

    if (isCategorical) {
      // Intersection des LABELS des tables de dimension (les IDs ne sont pas comparables)
      const inClauses = others.map(
        ({ cat, schema }) => `SELECT label FROM "${cat}".${schema}.dim_${fieldName}`,
      );

      let query = `SELECT value, label FROM "${primaryCat}".${primarySchema}.dim_${fieldName}`;
      if (inClauses.length > 0) {
        query += ` WHERE label IN (${inClauses.join(' INTERSECT ')})`;
      }
      query += ` LIMIT ${limit}`;

      // Les colonnes value et label sont sélectionnées explicitement dans la requête
      const rows = await connection.all(query);
      return rows as unknown as CrossDatabaseSelectOption[];
    } else {
      // Intersection des valeurs distinctes de la table des faits (continu : comparable)
      const inClauses = others.map(
        ({ cat, schema }) =>
          `SELECT DISTINCT CAST(${fieldName} AS VARCHAR) AS value FROM "${cat}".${schema}.fact_table`,
      );

      let query = `SELECT DISTINCT CAST(${fieldName} AS VARCHAR) AS value, CAST(${fieldName} AS VARCHAR) AS label FROM "${primaryCat}".${primarySchema}.fact_table`;
      if (inClauses.length > 0) {
        query += ` WHERE CAST(${fieldName} AS VARCHAR) IN (${inClauses.join(' INTERSECT ')})`;
      }
      query += ` LIMIT ${limit}`;

      // Les colonnes value et label sont sélectionnées explicitement dans la requête
      const rows = await connection.all(query);
      return rows as unknown as CrossDatabaseSelectOption[];
    }
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
