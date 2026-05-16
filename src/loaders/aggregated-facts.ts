// Importation des modules
import { FactQueryLoader } from './base-loader.js';
import { config } from '../utils/config-loader.js';
import { buildWhereClause } from '../utils/utils.js';
import type { DuckDBConnection, SortItem } from './base-loader.js';
import type { StructuredFilter } from '../utils/utils.js';

// ─── Interfaces des paramètres de requête ─────────────────────────────────────

/** Supported SQL aggregation type. */
type AggregationType = 'SUM' | 'AVG' | 'MAX' | 'MIN' | 'COUNT' | 'MEDIAN' | 'MODE';

/** Parameters for an aggregated fact query. */
interface AggregatedQueryParams {
    fields?: string[];
    filters?: string | null;
    structuredFilters?: StructuredFilter[] | null;
    groupBy: string;
    aggregation: AggregationType;
    limit: number;
    offset: number;
    sort?: SortItem[];
    format?: 'default' | 'with-metadata' | 'with-count';
    includeCount?: boolean;
    includeMetadata?: boolean;
}

// ─── Interfaces des résultats ─────────────────────────────────────────────────

/** Row of an aggregated fact result. */
interface AggregatedFactRow {
    key: string;
    aggregatedValue: number;
    count: number;
    _groupByField: string;
}

/** Descriptive statistics computed on aggregated values. */
interface AggregatedStatistics {
    mean: number | null;
    median: number | null;
    stdDev: number | null;
    quartiles: number[] | null;
}

/** Metadata of an aggregated result (extents, statistics, pagination). */
interface AggregatedMetadata {
    count: number;
    keyExtent: [number, number] | [string, string] | null;
    valueExtent: [number, number];
    groupByFieldInfo: Record<string, unknown> | null;
    generatedAt: string;
    statistics?: AggregatedStatistics;
    totalGroups?: number;
    hasNextPage?: boolean;
    currentPage?: number;
    totalPages?: number;
}

/** Aggregated result with metadata. */
interface AggregatedWithMetadata {
    data: AggregatedFactRow[];
    metadata: AggregatedMetadata;
}

/** Paginated aggregated result with total count. */
interface AggregatedWithCount {
    data: AggregatedFactRow[];
    totalGroups: number;
    hasNextPage: boolean;
    currentPage: number;
    totalPages: number;
}

/** Union of all possible result formats for aggregated facts. */
type AggregatedResult =
    | AggregatedFactRow[]
    | AggregatedWithMetadata
    | AggregatedWithCount
    | (AggregatedWithMetadata & { metadata: AggregatedMetadata & { totalGroups: number; hasNextPage: boolean; currentPage: number; totalPages: number } });

// Classe de chargement des faits agrégés
/**
 * Loader for aggregated fact queries.
 *
 * Groups fact table rows by a dimension field and applies a SQL aggregation
 * function (SUM, AVG, etc.). Supports optional metadata enrichment and
 * pagination with total group count.
 */
class AggregatedFactsLoader extends FactQueryLoader {

    // Initialisation avec la configuration spécifique aux faits agrégés
    /**
     * Creates an AggregatedFactsLoader bound to a specific database.
     *
     * @param databaseId - Catalog alias to query; null uses the default database.
     */
    constructor(databaseId: string | null = null) {
        super({
            batchSize: config.API.LOADERS.BATCH_SIZE,
            cachePrefix: 'aggregated-facts',
            cache: true,
            cacheTimeout: config.API.LOADERS.FACT_CACHE_TIMEOUT,
            databaseId
        });
    }

    // Association des types d'agrégation à leurs fonctions SQL
    /** Mapping between GraphQL aggregation types and SQL functions. */
    static AGGREGATION_MAP: Record<AggregationType, string> = {
        SUM: 'SUM',
        AVG: 'AVG',
        MAX: 'MAX',
        MIN: 'MIN',
        COUNT: 'COUNT',
        MEDIAN: 'MEDIAN',
        MODE: 'MODE'
    };

    // Méthode de chargement des faits agrégés
    /**
     * Loads aggregated fact data grouped by a dimension field.
     *
     * Applies filters, aggregation, sorting, and pagination. When
     * includeMetadata or includeCount are true, additional queries are
     * issued to compute statistics and total group count.
     *
     * @param connection - Active DuckDB connection from the pool.
     * @param params - Query parameters controlling grouping, aggregation, and format.
     * @returns Aggregated results in the requested format.
     * @throws {Error} When pagination parameters exceed configured limits.
     */
    async loadAggregatedFacts(
        connection: DuckDBConnection,
        params: AggregatedQueryParams
    ): Promise<AggregatedResult> {
        const {
            filters,
            structuredFilters,
            groupBy,
            aggregation,
            limit,
            offset,
            sort = [],
            format = 'default',
            includeCount = false,
            includeMetadata = false
        } = params;

        // Validation des paramètres de pagination
        this.validatePagination(limit, offset);

        // Construction de la condition de filtre
        const whereClause = buildWhereClause(filters, structuredFilters);

        // Résolution de la fonction SQL d'agrégation
        const aggregationQuery = AggregatedFactsLoader.AGGREGATION_MAP[aggregation] || 'SUM';

        // Construction du critère de tri
        const sortClause = sort.length > 0
            ? `ORDER BY ${sort.map(s =>
                s.field === 'key' ? 'key' : `aggregatedValue ${s.order}`
            ).join(', ')}`
            : '';

        // Construction de la requête principale
        const query = `
            SELECT
                ${groupBy} as key,
                ${aggregationQuery}(value) as aggregatedValue,
                COUNT(*) as count
            FROM ${this.qualifyTable('fact_table')}
            ${whereClause}
            GROUP BY ${groupBy}
            ${sortClause}
            LIMIT ${limit} OFFSET ${offset}
        `;

        // Exécution de la requête et mise en forme des lignes
        const results = await connection.all(query);
        const data: AggregatedFactRow[] = results.map(row => ({
            ...row,
            key: String(row.key),
            aggregatedValue: Number(row.aggregatedValue),
            count: Number(row.count),
            _groupByField: groupBy
        }));

        // Enrichissement avec les métadonnées si demandé
        let enrichedData: AggregatedResult = data;

        if (includeMetadata || format === 'with-metadata') {
            const metadata = await this.calculateMetadata(connection, data, params);
            enrichedData = { data, metadata };
        }

        // Enrichissement avec le comptage total des groupes si demandé
        if (includeCount || format === 'with-count') {
            const totalGroups = await this.getTotalGroups(connection, params);

            if (typeof enrichedData === 'object' && !Array.isArray(enrichedData) && (enrichedData as AggregatedWithMetadata).metadata) {
                // Enrichissement des métadonnées existantes avec la pagination
                const withMeta = enrichedData as AggregatedWithMetadata;
                withMeta.metadata = {
                    ...withMeta.metadata,
                    totalGroups,
                    hasNextPage: offset + limit < totalGroups,
                    currentPage: Math.floor(offset / limit) + 1,
                    totalPages: Math.ceil(totalGroups / limit)
                };
            } else {
                // Wrapper en objet paginé
                const wrappedData = Array.isArray(enrichedData)
                    ? enrichedData
                    : (enrichedData as AggregatedWithMetadata).data;
                enrichedData = {
                    data: wrappedData,
                    totalGroups,
                    hasNextPage: offset + limit < totalGroups,
                    currentPage: Math.floor(offset / limit) + 1,
                    totalPages: Math.ceil(totalGroups / limit)
                } as AggregatedWithCount;
            }
        }

        return enrichedData;
    }

    // Méthode pour obtenir le nombre total de groupes distincts
    /**
     * Gets the total number of distinct groups for pagination purposes.
     *
     * @param connection - Active DuckDB connection from the pool.
     * @param params - Query parameters (only filters and groupBy are used).
     * @returns Total distinct group count.
     */
    async getTotalGroups(
        connection: DuckDBConnection,
        params: Pick<AggregatedQueryParams, 'filters' | 'structuredFilters' | 'groupBy'>
    ): Promise<number> {
        const { filters, structuredFilters, groupBy } = params;
        const whereClause = buildWhereClause(filters, structuredFilters);

        const countQuery = `
            SELECT COUNT(DISTINCT ${groupBy}) as totalGroups
            FROM ${this.qualifyTable('fact_table')}
            ${whereClause}
        `;

        const result = await connection.all(countQuery);
        return result[0].totalGroups as number;
    }

    // Méthode de calcul des méta-données d'un résultat agrégé
    /**
     * Calculates metadata for a set of aggregated fact rows.
     *
     * Fetches groupBy field metadata, computes key and value extents, and
     * calculates descriptive statistics (mean, median, stdDev, quartiles).
     *
     * @param connection - Active DuckDB connection from the pool.
     * @param data - Array of aggregated fact rows already fetched.
     * @param params - Query parameters (only groupBy is used).
     * @returns AggregatedMetadata object with extents, field info, and statistics.
     */
    async calculateMetadata(
        connection: DuckDBConnection,
        data: AggregatedFactRow[],
        params: Pick<AggregatedQueryParams, 'groupBy'>
    ): Promise<AggregatedMetadata> {
        const { groupBy } = params;

        // Récupération des informations sur le champ de regroupement
        const fieldMetaQuery = `SELECT * FROM ${this.qualifyTable('metadata')} WHERE name = ?`;
        const fieldMeta = await connection.all(fieldMetaQuery, [groupBy]);

        // Calcul des extents de valeurs et de clés
        const values = data.map(d => d.aggregatedValue);
        const keys = data.map(d => d.key);

        // Cas sans données — métadonnées vides sûres
        if (keys.length === 0) {
            return {
                count: 0,
                keyExtent: null,
                valueExtent: [0, 0],
                groupByFieldInfo: (fieldMeta[0] as Record<string, unknown>) || null,
                generatedAt: new Date().toISOString()
            };
        }

        // Détection si les clés sont numériques
        const numericKeys = keys.every(k => !isNaN(parseFloat(k)));

        // Construction du dictionnaire de méta-données
        const metadata: AggregatedMetadata = {
            count: data.length,
            keyExtent: numericKeys
                ? [Math.min(...keys.map(Number)), Math.max(...keys.map(Number))]
                : [keys[0], keys[keys.length - 1]],
            valueExtent: [Math.min(...values), Math.max(...values)],
            groupByFieldInfo: (fieldMeta[0] as Record<string, unknown>) || null,
            generatedAt: new Date().toISOString()
        };

        // Calcul des statistiques descriptives
        metadata.statistics = this.calculateStatistics(values);

        return metadata;
    }

    // Méthode de calcul des statistiques descriptives sur les valeurs agrégées
    /**
     * Calculates descriptive statistics for an array of numeric values.
     *
     * @param values - Array of numeric aggregated values.
     * @returns Object with mean, median, standard deviation, and quartiles.
     *   All fields are null when values is empty.
     */
    calculateStatistics(values: number[]): AggregatedStatistics {
        if (!values || values.length === 0) {
            return { mean: null, median: null, stdDev: null, quartiles: null };
        }

        const sorted = [...values].sort((a, b) => a - b);
        const n = sorted.length;

        // Moyenne arithmétique
        const mean = values.reduce((a, b) => a + b, 0) / n;

        // Médiane (interpolation pour n pair)
        const median = n % 2 === 0
            ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
            : sorted[Math.floor(n / 2)];

        // Écart-type (variance population)
        const variance = values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / n;
        const stdDev = Math.sqrt(variance);

        // Quartiles Q1 et Q3
        const q1 = sorted[Math.floor(n * 0.25)];
        const q3 = sorted[Math.floor(n * 0.75)];

        return {
            mean,
            median,
            stdDev,
            quartiles: [sorted[0], q1, median, q3, sorted[n - 1]]
        };
    }
}

// Fonction de création d'un loader pour les faits agrégés (format par défaut)
/**
 * Creates a DataLoader for aggregated fact queries.
 *
 * @param databaseId - Catalog alias to query; null uses the default database.
 * @returns DataLoader keyed by AggregatedQueryParams, returning AggregatedResult.
 */
const createAggregatedFactsLoader = (databaseId: string | null = null) => {
    const loader = new AggregatedFactsLoader(databaseId);
    return loader.createLoader<AggregatedQueryParams, AggregatedResult>(
        (connection, params) => loader.loadAggregatedFacts(connection, params)
    );
};

// Fonction de création d'un loader pour les faits agrégés avec méta-données
/**
 * Creates a DataLoader for aggregated facts enriched with metadata.
 *
 * @param databaseId - Catalog alias to query; null uses the default database.
 * @returns DataLoader returning AggregatedWithMetadata results.
 */
const createAggregatedFactsWithMetadataLoader = (databaseId: string | null = null) => {
    const loader = new AggregatedFactsLoader(databaseId);
    return loader.createLoader<AggregatedQueryParams, AggregatedResult>(
        (connection, params) =>
            loader.loadAggregatedFacts(connection, { ...params, includeMetadata: true })
    );
};

// Fonction de création d'un loader pour les faits agrégés avec comptage des groupes
/**
 * Creates a DataLoader for aggregated facts with total group count.
 *
 * @param databaseId - Catalog alias to query; null uses the default database.
 * @returns DataLoader returning AggregatedWithCount results.
 */
const createAggregatedFactsWithCountLoader = (databaseId: string | null = null) => {
    const loader = new AggregatedFactsLoader(databaseId);
    return loader.createLoader<AggregatedQueryParams, AggregatedResult>(
        (connection, params) =>
            loader.loadAggregatedFacts(connection, { ...params, includeCount: true })
    );
};

export {
    createAggregatedFactsLoader,
    createAggregatedFactsWithMetadataLoader,
    createAggregatedFactsWithCountLoader,
    AggregatedFactsLoader
};
export type {
    AggregationType,
    AggregatedQueryParams,
    AggregatedFactRow,
    AggregatedStatistics,
    AggregatedMetadata,
    AggregatedWithMetadata,
    AggregatedWithCount,
    AggregatedResult
};
