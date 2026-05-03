// Importation des modules
import { FactQueryLoader } from './base-loader.js';
import { config } from '../utils/config-loader.js';
import { buildWhereClause } from '../utils/utils.js';
import type { DuckDBConnection, SortItem, D3QueryResult } from './base-loader.js';
import type { StructuredFilter } from '../utils/utils.js';

// ─── Interfaces des paramètres de requête ─────────────────────────────────────

/** Paramètres d'une requête sur la table des faits. */
interface FactQueryParams {
    fields?: string[];
    filters?: string | null;
    structuredFilters?: StructuredFilter[] | null;
    limit: number;
    offset: number;
    sort?: SortItem[];
    format?: 'default' | 'metadata' | 'json' | 'with-count';
    includeCount?: boolean;
}

// ─── Interfaces des résultats ─────────────────────────────────────────────────

/** Résultat paginé standard avec comptage total. */
interface PaginatedFactResult {
    data: Record<string, unknown>[] | unknown[][];
    total: number;
    hasNextPage: boolean;
    currentPage: number;
    totalPages: number;
    generatedAt: string;
}

/** Résultat D3 paginé (metadata enrichie de données de pagination). */
interface PaginatedD3Result extends D3QueryResult {
    metadata: D3QueryResult['metadata'] & {
        total: number;
        hasNextPage: boolean;
        currentPage: number;
        totalPages: number;
        generatedAt: string;
    };
}

/** Union de tous les formats possibles retournés par loadFacts. */
type FactQueryResult =
    | Record<string, unknown>[]
    | unknown[][]
    | D3QueryResult
    | PaginatedFactResult
    | PaginatedD3Result;

// Classe de chargement de la table des faits
/**
 * Loader for the fact table.
 *
 * Supports multiple output formats (default array, JSON array, D3 metadata)
 * and optional count enrichment for pagination.
 */
class FactLoader extends FactQueryLoader {

    // Initialisation avec la configuration spécifique aux faits
    /**
     * Creates a FactLoader bound to a specific database.
     *
     * Args:
     *     databaseId: Catalog alias to query; null uses the default database.
     */
    constructor(databaseId: string | null = null) {
        super({
            batchSize: config.API.LOADERS.BATCH_SIZE,
            cachePrefix: 'facts',
            cache: true,
            cacheTimeout: config.API.LOADERS.FACT_CACHE_TIMEOUT,
            databaseId
        });
    }

    // Méthode de chargement basée sur les paramètres de requête
    /**
     * Loads fact data based on query parameters.
     *
     * Builds a parameterized SQL query and returns results in the requested
     * format. When includeCount is true, a separate COUNT query is issued
     * and the result is wrapped with pagination metadata.
     *
     * Args:
     *     connection: Active DuckDB connection from the pool.
     *     params: Query parameters controlling fields, filters, and format.
     *
     * Returns:
     *     Query results in the requested format, optionally with count.
     *
     * Raises:
     *     Error: When pagination parameters exceed configured limits.
     */
    async loadFacts(connection: DuckDBConnection, params: FactQueryParams): Promise<FactQueryResult> {
        const {
            fields,
            filters,
            structuredFilters,
            limit,
            offset,
            sort,
            format = 'default',
            includeCount = false
        } = params;

        // Validation des paramètres de pagination
        this.validatePagination(limit, offset);

        // Construction des clauses SQL
        const selectClause = this.buildSelectClause(fields);
        const whereClause = buildWhereClause(filters, structuredFilters);
        const sortClause = this.buildSortClause(sort);

        const query = `
            SELECT ${selectClause} FROM ${this.qualifyTable('fact_table')}
            ${whereClause}
            ${sortClause}
            LIMIT ${limit} OFFSET ${offset}
        `;

        // Récupération des données selon le format demandé
        let data: FactQueryResult;
        switch (format) {
            case 'metadata':
                // Format enrichi avec métadonnées D3 (colonnes, extents)
                data = await connection.getWithMetadata(query);
                break;
            case 'json':
                // Format tableau de tableaux optimisé pour les gros datasets
                data = await connection.getAsJsonArray(query);
                break;
            default:
                // Format par défaut — tableau d'objets
                data = await connection.all(query);
        }

        // Enrichissement avec le comptage total si demandé
        if (includeCount || format === 'with-count') {
            const total = await this.getCount(connection, { filters, structuredFilters });

            // Enrichissement des métadonnées D3 si déjà présentes
            if (format === 'metadata' && (data as D3QueryResult).metadata) {
                const d3Data = data as D3QueryResult;
                (data as PaginatedD3Result).metadata = {
                    ...d3Data.metadata,
                    total,
                    hasNextPage: offset + limit < total,
                    currentPage: Math.floor(offset / limit) + 1,
                    totalPages: Math.ceil(total / limit),
                    generatedAt: new Date().toISOString()
                };
            } else {
                // Wrapper en objet paginé pour les autres formats
                data = {
                    data: Array.isArray(data) ? data : ((data as D3QueryResult)?.data || []),
                    total,
                    hasNextPage: offset + limit < total,
                    currentPage: Math.floor(offset / limit) + 1,
                    totalPages: Math.ceil(total / limit),
                    generatedAt: new Date().toISOString()
                } as PaginatedFactResult;
            }
        }

        return data;
    }

    // Méthode de comptage du nombre total d'observations correspondant aux filtres
    /**
     * Gets the total count of rows matching the given filters.
     *
     * Args:
     *     connection: Active DuckDB connection from the pool.
     *     filters: Object containing raw and structured filter parameters.
     *
     * Returns:
     *     Total row count as a number.
     */
    async getCount(
        connection: DuckDBConnection,
        { filters, structuredFilters }: Pick<FactQueryParams, 'filters' | 'structuredFilters'>
    ): Promise<number> {
        const whereClause = buildWhereClause(filters, structuredFilters);
        const countQuery = `SELECT COUNT(*) as total FROM ${this.qualifyTable('fact_table')} ${whereClause}`;
        const result = await connection.all(countQuery);
        return result[0].total as number;
    }
}

// Fonction de création d'un loader pour la table des faits
/**
 * Creates a DataLoader for fact table queries in default format.
 *
 * Args:
 *     databaseId: Catalog alias to query; null uses the default database.
 *
 * Returns:
 *     DataLoader keyed by FactQueryParams, returning FactQueryResult.
 */
const createFactLoader = (databaseId: string | null = null) => {
    const loader = new FactLoader(databaseId);
    return loader.createLoader<FactQueryParams, FactQueryResult>(
        (connection, params) => loader.loadFacts(connection, params)
    );
};

// Fonction de création d'un loader pour la table des faits avec comptage total
/**
 * Creates a DataLoader for fact table queries with row count included.
 *
 * Args:
 *     databaseId: Catalog alias to query; null uses the default database.
 *
 * Returns:
 *     DataLoader returning paginated fact results with total count.
 */
const createFactWithCountLoader = (databaseId: string | null = null) => {
    const loader = new FactLoader(databaseId);
    return loader.createLoader<FactQueryParams, FactQueryResult>(
        (connection, params) => loader.loadFacts(connection, { ...params, includeCount: true })
    );
};

// Fonction de création d'un loader pour la table des faits avec métadonnées D3
/**
 * Creates a DataLoader for fact table queries in D3 metadata format with count.
 *
 * Args:
 *     databaseId: Catalog alias to query; null uses the default database.
 *
 * Returns:
 *     DataLoader returning D3-formatted facts with column metadata and count.
 */
const createFactWithMetadataLoader = (databaseId: string | null = null) => {
    const loader = new FactLoader(databaseId);
    return loader.createLoader<FactQueryParams, FactQueryResult>(
        (connection, params) =>
            loader.loadFacts(connection, { ...params, format: 'metadata', includeCount: true })
    );
};

export { createFactLoader, createFactWithCountLoader, createFactWithMetadataLoader, FactLoader };
export type { FactQueryParams, FactQueryResult, PaginatedFactResult };
