// Importation des modules
import { FactQueryLoader } from './base-loader.js';
import { config } from '../utils/config-loader.js';
import { buildAggregateQuery, buildGroupCountQuery } from '../utils/aggregate-query.js';
import type { Json } from '@duckdb/node-api';
import type { DuckDBConnection } from './base-loader.js';
import type { AggregatePageParams, AggregateCountParams } from '../utils/aggregate-query.js';
import type { ColumnExtent } from '../db/json-conversion.js';

// ─── Interfaces des résultats ─────────────────────────────────────────────────

/** One page of an aggregate query, rows as objects. */
interface AggregatePage {
  /** Output columns, in SELECT order: groups, labels, aliases, row_count. */
  columns: string[];
  /** DuckDB types of the columns, same order (e.g. HUGEINT for a SUM of BIGINT). */
  columnTypes: string[];
  /** Rows, serialized by the single JSON converter (NULL preserved). */
  data: Record<string, Json>[];
  /** [min, max] of the numeric and temporal columns of the page, keyed by column. */
  extents: Record<string, ColumnExtent>;
}

// Classe de chargement des agrégats
/**
 * Loader of aggregate queries (getAggregates).
 *
 * Runs the SQL of buildAggregateQuery — every aggregate of every group in one
 * query — and, as a separate variant with its own cache entry, the group count
 * of buildGroupCountQuery, so that paging through the groups never recounts
 * them. The cache prefix `aggregated-facts` keeps the entries under the
 * existing invalidation pattern.
 */
class AggregatesLoader extends FactQueryLoader {
  /**
   * Creates an AggregatesLoader bound to a specific database.
   *
   * @param catalogId - Catalog alias to query; null uses the default catalog.
   * @param schema - DuckLake schema within the catalog; null uses the catalog default.
   * @param cacheVariant - Result variant included in the cache key (null = page).
   */
  constructor(
    catalogId: string | null = null,
    schema: string | null = null,
    cacheVariant: string | null = null,
  ) {
    super({
      batchSize: config.API.LOADERS.BATCH_SIZE,
      cachePrefix: 'aggregated-facts',
      cache: true,
      cacheTimeout: config.API.LOADERS.FACT_CACHE_TIMEOUT,
      // Échéance alignée sur le timeout du resolver consommateur
      queryTimeout: config.API.TIMEOUTS.AGGREGATED_COMPLEX,
      catalogId,
      schema,
      cacheVariant,
    });
  }

  /**
   * Loads one page of aggregates.
   *
   * The parameters were resolved and validated by resolveAggregateParams; the
   * column types and the page extents come with the rows, so the resolver
   * describes each aggregate without a second query.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param params - Resolved parameters, compiled filter and page.
   * @returns The page, with its columns, their types and extents.
   */
  async loadPage(
    connection: DuckDBConnection,
    params: AggregatePageParams,
  ): Promise<AggregatePage> {
    const { sql, values } = buildAggregateQuery(params, this.qualifyTable('fact_table'));
    const result = await connection.getWithMetadata(sql, values);
    return {
      columns: result.columns,
      columnTypes: result.columnTypes ?? [],
      data: result.data as Record<string, Json>[],
      extents: result.metadata.extents,
    };
  }

  /**
   * Counts the groups of an aggregate query, NULL group included.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param params - Group columns and compiled filter.
   * @returns Number of groups.
   */
  async loadGroupCount(
    connection: DuckDBConnection,
    params: AggregateCountParams,
  ): Promise<number> {
    const { sql, values } = buildGroupCountQuery(params, this.qualifyTable('fact_table'));
    const rows = await connection.all(sql, values);
    return Number(rows[0]?.total ?? 0);
  }
}

/**
 * Creates a DataLoader of aggregate pages.
 *
 * @param catalogId - Catalog alias to query; null uses the default catalog.
 * @param schema - DuckLake schema within the catalog; null uses the catalog default.
 * @returns DataLoader keyed by AggregatePageParams.
 */
const createAggregatesLoader = (catalogId: string | null = null, schema: string | null = null) => {
  const loader = new AggregatesLoader(catalogId, schema);
  return loader.createLoader<AggregatePageParams, AggregatePage>((connection, params) =>
    loader.loadPage(connection, params),
  );
};

/**
 * Creates a DataLoader of group counts, cached apart from the pages.
 *
 * @param catalogId - Catalog alias to query; null uses the default catalog.
 * @param schema - DuckLake schema within the catalog; null uses the catalog default.
 * @returns DataLoader keyed by AggregateCountParams.
 */
const createAggregateGroupCountLoader = (
  catalogId: string | null = null,
  schema: string | null = null,
) => {
  const loader = new AggregatesLoader(catalogId, schema, 'count');
  return loader.createLoader<AggregateCountParams, number>((connection, params) =>
    loader.loadGroupCount(connection, params),
  );
};

export { AggregatesLoader, createAggregatesLoader, createAggregateGroupCountLoader };
export type { AggregatePage };
