// Importation des modules
import { BaseQueryLoader } from './base-loader.js';
import { config } from '../utils/config-loader.js';
import { buildWhere } from '../utils/filter-tree.js';
import { validateIdentifier } from '../utils/utils.js';
import type { DuckDBConnection } from './base-loader.js';
import type { CompiledFilter } from '../utils/filter-tree.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Parameters of a column statistics query. */
interface FieldStatsParams {
  /** Column of the fact table; validated as a SQL identifier before interpolation. */
  fieldName: string;
  /** Filter compiled by treeToSQL (never built from raw client SQL); null = whole table. */
  where?: CompiledFilter | null;
}

/** Statistics of one fact table column. */
interface FieldStats {
  /** Smallest value: a number, an ISO 8601 date/timestamp, a string; null on an empty column. */
  min: string | number | boolean | null;
  /** Largest value, same forms as `min`. */
  max: string | number | boolean | null;
  /** Number of distinct non-NULL values. */
  distinctCount: number;
  /** Number of NULL values. */
  nullCount: number;
}

// Classe de chargement des statistiques d'une colonne
/**
 * Loader for on-demand column statistics.
 *
 * One query per column: `SELECT MIN(col), MAX(col), COUNT(DISTINCT col),
 * COUNT(*) - COUNT(col) FROM fact_table [WHERE ...]`. The result is exact by
 * construction and cheap on columnar Parquet, very cheap on the `cluster_by`
 * columns (sorted data, tight row group statistics).
 *
 * The statistics of the DuckLake catalog (`ducklake_file_column_stats`) are
 * deliberately NOT read: they are kept per file (an aggregation would still be
 * needed), do not cover the rows inlined in the catalog by small updates, and
 * stay wide bounds after a DELETE until `rewrite_data_files` rewrites the file.
 * Computing from the table is the only way to
 * stay exact — and the only one that can honor a filter.
 *
 * Values are serialized by the single DuckDB → JSON converter of the pool: an
 * integer beyond 2^53 comes back as its exact decimal string, a DATE as
 * `YYYY-MM-DD`, a TIMESTAMP as ISO 8601. On a text or boolean column, min and
 * max are still computed — in lexical order for text, false < true for
 * booleans — and carry no calibration meaning for a slider.
 *
 * Cache: the unfiltered variant only changes with the nightly refresh (which
 * invalidates the cache), so it gets the long select options TTL; a filtered
 * variant is one of many combinations and gets the short fact TTL. The filter
 * is part of the key, so the two never share an entry, and the key layout
 * `field-stats:<catalog>:<schema>:…` is covered by the invalidation by prefix.
 */
class FieldStatsLoader extends BaseQueryLoader {
  // Initialisation avec la configuration spécifique aux statistiques
  /**
   * Creates a FieldStatsLoader bound to a specific database.
   *
   * @param catalogId - Catalog alias to query; null uses the default catalog.
   * @param schema - DuckLake schema within the catalog; null uses the catalog default.
   */
  constructor(catalogId: string | null = null, schema: string | null = null) {
    super({
      batchSize: config.API.LOADERS.BATCH_SIZE,
      cachePrefix: 'field-stats',
      cache: true,
      cacheTimeout: config.API.LOADERS.SELECT_OPTIONS_CACHE_TIMEOUT,
      catalogId,
      schema,
    });
  }

  // TTL long sans filtre, court avec filtre
  /**
   * Returns the TTL of a key: long when unfiltered, short when filtered.
   *
   * @param key - DataLoader key ({@link FieldStatsParams}).
   * @returns SELECT_OPTIONS_CACHE_TIMEOUT without filter, FACT_CACHE_TIMEOUT with one.
   */
  override cacheTimeoutFor(key: unknown): number {
    const { where } = key as FieldStatsParams;
    return where && where.sql
      ? config.API.LOADERS.FACT_CACHE_TIMEOUT
      : config.API.LOADERS.SELECT_OPTIONS_CACHE_TIMEOUT;
  }

  // Méthode de calcul des statistiques d'une colonne
  /**
   * Computes the statistics of one column, optionally restricted by a filter.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param params - Column name and optional compiled filter.
   * @returns Min, max, distinct count and NULL count of the column.
   * @throws {GraphQLError} BAD_USER_INPUT when fieldName is not a valid identifier.
   */
  async loadStats(connection: DuckDBConnection, params: FieldStatsParams): Promise<FieldStats> {
    // Identifiant validé avant toute interpolation (anti-injection)
    const column = validateIdentifier(params.fieldName, 'field');
    const whereClause = buildWhere(params.where);

    const query = `
      SELECT MIN(${column}) AS min_value,
             MAX(${column}) AS max_value,
             COUNT(DISTINCT ${column}) AS distinct_count,
             COUNT(*) - COUNT(${column}) AS null_count
      FROM ${this.qualifyTable('fact_table')}
      ${whereClause}
    `;
    const [row] = await connection.all(query, params.where?.params ?? []);

    return {
      min: (row.min_value ?? null) as FieldStats['min'],
      max: (row.max_value ?? null) as FieldStats['max'],
      distinctCount: Number(row.distinct_count),
      nullCount: Number(row.null_count),
    };
  }
}

// Fonction de création d'un loader pour les statistiques de colonne
/**
 * Creates a DataLoader for column statistics.
 *
 * @param catalogId - Catalog alias to query; null uses the default catalog.
 * @param schema - DuckLake schema within the catalog; null uses the catalog default.
 * @returns DataLoader keyed by FieldStatsParams, returning FieldStats.
 */
const createFieldStatsLoader = (catalogId: string | null = null, schema: string | null = null) => {
  const loader = new FieldStatsLoader(catalogId, schema);
  return loader.createLoader<FieldStatsParams, FieldStats>((connection, params) =>
    loader.loadStats(connection, params),
  );
};

export { createFieldStatsLoader, FieldStatsLoader };
export type { FieldStatsParams, FieldStats };
