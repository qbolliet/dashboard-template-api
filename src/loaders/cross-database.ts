// Importation des modules
import { BaseQueryLoader } from './base-loader.js';
import { databaseManager } from '../db/index.js';
import { config } from '../utils/config-loader.js';
import { AggregatedFactsLoader } from './aggregated-facts.js';
import { validateIdentifier } from '../utils/utils.js';
import type { DuckDBConnection, SortItem } from './base-loader.js';
import type { AggregationType } from './aggregated-facts.js';

// ─── Interfaces des paramètres de requêtes cross-database ─────────────────────

/** Parameters for comparing the fact table between two databases. */
interface CompareFactsParams {
    databaseA: string;
    databaseB: string;
    joinFields: string[];
    limit: number;
    offset: number;
    sort?: SortItem[];
}

/** Parameters for comparing aggregated facts between two databases. */
interface CompareAggregatedFactsParams {
    databaseA: string;
    databaseB: string;
    groupBy: string;
    aggregation?: AggregationType;
    limit: number;
    offset: number;
}

/** Parameters for cross-database select option intersection queries. */
interface CrossDatabaseSelectOptionsParams {
    fieldName: string;
    databases: string[];
    limit: number;
}

// ─── Interfaces des résultats ─────────────────────────────────────────────────

/** Comparison row between two databases (delta and delta%). */
interface ComparisonRow {
    key: string;
    valueA: number | null;
    valueB: number | null;
    delta: number | null;
    deltaPercent: number | null;
}

/** Paginated result of a cross-database comparison. */
interface ComparisonResult {
    data: ComparisonRow[];
    total: number;
    hasNextPage: boolean;
    currentPage: number;
    totalPages: number;
}

/** Select option from a cross-database query. */
interface CrossDatabaseSelectOption {
    value: unknown;
    label?: unknown;
}

// Classe de chargement des requêtes cross-database
/**
 * Loader for cross-database comparison queries.
 *
 * Compares fact and aggregated fact data between two catalogs, and
 * computes the intersection of select options across multiple catalogs.
 */
class CrossDatabaseLoader extends BaseQueryLoader {

    // Initialisation sans identifiant de base de données (requêtes cross-catalog)
    /**
     * Creates a CrossDatabaseLoader with no specific database binding.
     *
     * Database identifiers are passed through the query params at load time.
     */
    constructor() {
        super({
            batchSize: 1,
            cachePrefix: 'cross-database',
            cache: true,
            cacheTimeout: config.API.LOADERS.FACT_CACHE_TIMEOUT,
            databaseId: null
        });
    }

    // Méthode de comparaison des tables de faits entre deux bases de données
    /**
     * Compares fact table rows between two databases via a JOIN on shared fields.
     *
     * Returns delta (B - A) and deltaPercent ((B - A) / A * 100) per row.
     * Pagination metadata (total, hasNextPage, etc.) is included in the result.
     *
     * @param connection - Active DuckDB connection from the pool.
     * @param params - Parameters defining the two databases, join fields, and pagination.
     * @returns Paginated comparison result with delta values.
     */
    async compareFacts(
        connection: DuckDBConnection,
        params: CompareFactsParams
    ): Promise<ComparisonResult> {
        const {
            databaseA,
            databaseB,
            joinFields,
            limit,
            offset,
            sort = []
        } = params;

        const dm = databaseManager as { getSchema: (id: string) => string };
        const schemaA = dm.getSchema(databaseA);
        const schemaB = dm.getSchema(databaseB);

        // Validation des identifiants de jointure pour éviter les injections SQL
        joinFields.forEach(f => validateIdentifier(f, 'joinField'));
        const joinCondition = joinFields.map(f => `a.${f} = b.${f}`).join(' AND ');

        const sortClause = sort.length > 0
            ? `ORDER BY ${sort.map(s => `${s.field} ${s.order}`).join(', ')}`
            : '';

        // Expression de la clé principale dans le résultat
        const keyExpr = joinFields.length === 1
            ? `a.${joinFields[0]}`
            : `CONCAT(${joinFields.map(f => `CAST(a.${f} AS VARCHAR)`).join(", '::', ")})`;

        const query = `
            SELECT
                ${keyExpr} AS key,
                a.value AS valueA,
                b.value AS valueB,
                b.value - a.value AS delta,
                CASE WHEN a.value IS NOT NULL AND a.value != 0
                    THEN (b.value - a.value) / a.value * 100.0
                END AS deltaPercent
            FROM "${databaseA}".${schemaA}.fact_table a
            JOIN "${databaseB}".${schemaB}.fact_table b
                ON ${joinCondition}
            ${sortClause}
            LIMIT ${limit} OFFSET ${offset}
        `;

        // Comptage total pour le calcul de la pagination
        const countQuery = `
            SELECT COUNT(*) AS total
            FROM "${databaseA}".${schemaA}.fact_table a
            JOIN "${databaseB}".${schemaB}.fact_table b
                ON ${joinCondition}
        `;

        const [results, countResult] = await Promise.all([
            connection.all(query),
            connection.all(countQuery)
        ]);
        const total = Number(countResult[0]?.total ?? 0);

        return {
            data: results.map(row => ({
                key: String(row.key),
                valueA: row.valueA != null ? Number(row.valueA) : null,
                valueB: row.valueB != null ? Number(row.valueB) : null,
                delta: row.delta != null ? Number(row.delta) : null,
                deltaPercent: row.deltaPercent != null ? Number(row.deltaPercent) : null
            })),
            total,
            hasNextPage: offset + limit < total,
            currentPage: Math.floor(offset / limit) + 1,
            totalPages: limit > 0 ? Math.ceil(total / limit) : 1
        };
    }

    // Méthode de comparaison des faits agrégés entre deux bases de données
    /**
     * Compares aggregated fact values between two databases.
     *
     * Uses CTEs to pre-aggregate each side before joining, avoiding
     * Cartesian products. Returns delta and deltaPercent per group key.
     *
     * @param connection - Active DuckDB connection from the pool.
     * @param params - Parameters defining databases, groupBy, aggregation, and pagination.
     * @returns Paginated comparison result with aggregated delta values.
     */
    async compareAggregatedFacts(
        connection: DuckDBConnection,
        params: CompareAggregatedFactsParams
    ): Promise<ComparisonResult> {
        const {
            databaseA,
            databaseB,
            groupBy,
            aggregation = 'SUM',
            limit,
            offset
        } = params;

        const dm = databaseManager as { getSchema: (id: string) => string };
        const schemaA = dm.getSchema(databaseA);
        const schemaB = dm.getSchema(databaseB);

        validateIdentifier(groupBy, 'groupBy');
        const aggFn = AggregatedFactsLoader.AGGREGATION_MAP[aggregation as AggregationType] || 'SUM';

        // CTEs pour pré-agréger chaque côté avant la jointure — évite le produit cartésien
        const query = `
            WITH agg_a AS (
                SELECT ${groupBy} AS key, ${aggFn}(value) AS value
                FROM "${databaseA}".${schemaA}.fact_table
                GROUP BY ${groupBy}
            ),
            agg_b AS (
                SELECT ${groupBy} AS key, ${aggFn}(value) AS value
                FROM "${databaseB}".${schemaB}.fact_table
                GROUP BY ${groupBy}
            )
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

        // Comptage total des groupes communs pour la pagination
        const countQuery = `
            WITH keys_a AS (SELECT DISTINCT ${groupBy} AS key FROM "${databaseA}".${schemaA}.fact_table),
                 keys_b AS (SELECT DISTINCT ${groupBy} AS key FROM "${databaseB}".${schemaB}.fact_table)
            SELECT COUNT(*) AS total FROM keys_a JOIN keys_b ON keys_a.key = keys_b.key
        `;

        const [results, countResult] = await Promise.all([
            connection.all(query),
            connection.all(countQuery)
        ]);
        const total = Number(countResult[0]?.total ?? 0);

        return {
            data: results.map(row => ({
                key: String(row.key),
                valueA: row.valueA != null ? Number(row.valueA) : null,
                valueB: row.valueB != null ? Number(row.valueB) : null,
                delta: row.delta != null ? Number(row.delta) : null,
                deltaPercent: row.deltaPercent != null ? Number(row.deltaPercent) : null
            })),
            total,
            hasNextPage: offset + limit < total,
            currentPage: Math.floor(offset / limit) + 1,
            totalPages: limit > 0 ? Math.ceil(total / limit) : 1
        };
    }

    // Méthode de calcul de l'intersection des options de sélection entre catalogues
    /**
     * Computes the intersection of select options across multiple catalogs.
     *
     * Uses the primary catalog for labels and applies IN/INTERSECT subqueries
     * to restrict results to values present in all other catalogs.
     *
     * @param connection - Active DuckDB connection from the pool.
     * @param params - Parameters defining the field, database list, and limit.
     * @returns Array of options present in all provided catalogs.
     */
    async crossDatabaseSelectOptions(
        connection: DuckDBConnection,
        params: CrossDatabaseSelectOptionsParams
    ): Promise<CrossDatabaseSelectOption[]> {
        const { fieldName, databases, limit } = params;
        validateIdentifier(fieldName, 'fieldName');

        if (databases.length === 0) return [];

        const dm = databaseManager as { getSchema: (id: string) => string };
        const [primaryDb, ...otherDbs] = databases;
        const primarySchema = dm.getSchema(primaryDb);

        // Détermination du type du champ via les méta-données du premier catalogue
        const metaQuery = `SELECT is_categorical FROM "${primaryDb}".${primarySchema}.metadata WHERE name = ?`;
        const metaResult = await connection.all(metaQuery, [fieldName]);
        const isCategorical = metaResult[0]?.is_categorical;

        if (isCategorical) {
            // Intersection des valeurs des tables de dimension, labels du premier catalogue
            const inClauses = otherDbs.map(db => {
                const schema = dm.getSchema(db);
                return `SELECT value FROM "${db}".${schema}.dim_${fieldName}`;
            });

            let query = `SELECT value, label FROM "${primaryDb}".${primarySchema}.dim_${fieldName}`;
            if (inClauses.length > 0) {
                query += ` WHERE value IN (${inClauses.join(' INTERSECT ')})`;
            }
            query += ` LIMIT ${limit}`;

            // Les colonnes value et label sont sélectionnées explicitement dans la requête
            const rows = await connection.all(query);
            return rows as unknown as CrossDatabaseSelectOption[];
        } else {
            // Intersection des valeurs distinctes de la table des faits
            const inClauses = otherDbs.map(db => {
                const schema = dm.getSchema(db);
                return `SELECT DISTINCT CAST(${fieldName} AS VARCHAR) AS value FROM "${db}".${schema}.fact_table`;
            });

            let query = `SELECT DISTINCT CAST(${fieldName} AS VARCHAR) AS value, CAST(${fieldName} AS VARCHAR) AS label FROM "${primaryDb}".${primarySchema}.fact_table`;
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

// Fonction de création d'un loader pour la comparaison des faits entre bases de données
/**
 * Creates a DataLoader for fact table comparison between two databases.
 *
 * @returns DataLoader keyed by CompareFactsParams, returning ComparisonResult.
 */
const createCompareFacts = () => {
    const loader = new CrossDatabaseLoader();
    return loader.createLoader<CompareFactsParams, ComparisonResult>(
        (connection, params) => loader.compareFacts(connection, params)
    );
};

// Fonction de création d'un loader pour la comparaison des faits agrégés
/**
 * Creates a DataLoader for aggregated fact comparison between two databases.
 *
 * @returns DataLoader keyed by CompareAggregatedFactsParams, returning ComparisonResult.
 */
const createCompareAggregatedFacts = () => {
    const loader = new CrossDatabaseLoader();
    return loader.createLoader<CompareAggregatedFactsParams, ComparisonResult>(
        (connection, params) => loader.compareAggregatedFacts(connection, params)
    );
};

// Fonction de création d'un loader pour les options cross-database
/**
 * Creates a DataLoader for cross-database select option intersection queries.
 *
 * @returns DataLoader keyed by CrossDatabaseSelectOptionsParams.
 */
const createCrossDatabaseSelectOptions = () => {
    const loader = new CrossDatabaseLoader();
    return loader.createLoader<CrossDatabaseSelectOptionsParams, CrossDatabaseSelectOption[]>(
        (connection, params) => loader.crossDatabaseSelectOptions(connection, params)
    );
};

export {
    createCompareFacts,
    createCompareAggregatedFacts,
    createCrossDatabaseSelectOptions,
    CrossDatabaseLoader
};
export type {
    CompareFactsParams,
    CompareAggregatedFactsParams,
    CrossDatabaseSelectOptionsParams,
    ComparisonRow,
    ComparisonResult,
    CrossDatabaseSelectOption
};
