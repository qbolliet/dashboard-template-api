import { BaseQueryLoader } from './base-loader.js';
import { databaseManager } from '../db/index.js';
import { config } from '../utils/config-loader.js';
import { AggregatedFactsLoader } from './aggregated-facts.js';

class CrossDatabaseLoader extends BaseQueryLoader {
    constructor() {
        super({
            batchSize: 1,
            cachePrefix: 'cross-database',
            cache: true,
            cacheTimeout: config.API.LOADERS.FACT_CACHE_TIMEOUT,
            databaseId: null
        });
    }

    async compareFacts(connection, params) {
        const {
            databaseA,
            databaseB,
            joinFields,
            limit,
            offset,
            sort = []
        } = params;

        const schemaA = databaseManager.getSchema(databaseA);
        const schemaB = databaseManager.getSchema(databaseB);

        const joinCondition = joinFields
            .map(f => `a.${f} = b.${f}`)
            .join(' AND ');

        const sortClause = sort.length > 0
            ? `ORDER BY ${sort.map(s => `${s.field} ${s.order}`).join(', ')}`
            : '';

        // La première joinField est exposée comme clé principale dans le résultat
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

        const results = await connection.all(query);
        return results.map(row => ({
            key: String(row.key),
            valueA: row.valueA != null ? Number(row.valueA) : null,
            valueB: row.valueB != null ? Number(row.valueB) : null,
            delta: row.delta != null ? Number(row.delta) : null,
            deltaPercent: row.deltaPercent != null ? Number(row.deltaPercent) : null
        }));
    }

    async compareAggregatedFacts(connection, params) {
        const {
            databaseA,
            databaseB,
            groupBy,
            aggregation = 'SUM',
            limit,
            offset
        } = params;

        const schemaA = databaseManager.getSchema(databaseA);
        const schemaB = databaseManager.getSchema(databaseB);
        const aggFn = AggregatedFactsLoader.AGGREGATION_MAP[aggregation] || 'SUM';

        // Les sous-requêtes évitent toute ambiguïté de colonne dans la jointure
        const query = `
            SELECT
                a.${groupBy} AS key,
                ${aggFn}(a.value) AS valueA,
                ${aggFn}(b.value) AS valueB,
                ${aggFn}(b.value) - ${aggFn}(a.value) AS delta,
                CASE WHEN ${aggFn}(a.value) != 0
                    THEN (${aggFn}(b.value) - ${aggFn}(a.value)) / ${aggFn}(a.value) * 100.0
                END AS deltaPercent
            FROM "${databaseA}".${schemaA}.fact_table a
            JOIN "${databaseB}".${schemaB}.fact_table b
                ON a.${groupBy} = b.${groupBy}
            GROUP BY a.${groupBy}
            LIMIT ${limit} OFFSET ${offset}
        `;

        const results = await connection.all(query);
        return results.map(row => ({
            key: String(row.key),
            valueA: row.valueA != null ? Number(row.valueA) : null,
            valueB: row.valueB != null ? Number(row.valueB) : null,
            delta: row.delta != null ? Number(row.delta) : null,
            deltaPercent: row.deltaPercent != null ? Number(row.deltaPercent) : null
        }));
    }

    async crossDatabaseSelectOptions(connection, params) {
        const { fieldName, databases, limit } = params;

        if (databases.length === 0) return [];

        const [primaryDb, ...otherDbs] = databases;
        const primarySchema = databaseManager.getSchema(primaryDb);

        // Déterminer si le champ est catégoriel dans le premier catalogue
        const metaQuery = `SELECT is_categorical FROM "${primaryDb}".${primarySchema}.metadata WHERE name = ?`;
        const metaResult = await connection.all(metaQuery, [fieldName]);
        const isCategorical = metaResult[0]?.is_categorical;

        if (isCategorical) {
            // Intersection des valeurs des tables de dimension, labels du premier catalogue
            const inClauses = otherDbs.map(db => {
                const schema = databaseManager.getSchema(db);
                return `SELECT value FROM "${db}".${schema}.dim_${fieldName}`;
            });

            let query = `SELECT value, label FROM "${primaryDb}".${primarySchema}.dim_${fieldName}`;
            if (inClauses.length > 0) {
                query += ` WHERE value IN (${inClauses.join(' INTERSECT ')})`;
            }
            query += ` LIMIT ${limit}`;

            return connection.all(query);
        } else {
            // Intersection des valeurs distinctes de la table des faits
            const inClauses = otherDbs.map(db => {
                const schema = databaseManager.getSchema(db);
                return `SELECT DISTINCT CAST(${fieldName} AS VARCHAR) AS value FROM "${db}".${schema}.fact_table`;
            });

            let query = `SELECT DISTINCT CAST(${fieldName} AS VARCHAR) AS value, CAST(${fieldName} AS VARCHAR) AS label FROM "${primaryDb}".${primarySchema}.fact_table`;
            if (inClauses.length > 0) {
                query += ` WHERE CAST(${fieldName} AS VARCHAR) IN (${inClauses.join(' INTERSECT ')})`;
            }
            query += ` LIMIT ${limit}`;

            return connection.all(query);
        }
    }
}

const createCompareFacts = () => {
    const loader = new CrossDatabaseLoader();
    return loader.createLoader((connection, params) =>
        loader.compareFacts(connection, params)
    );
};

const createCompareAggregatedFacts = () => {
    const loader = new CrossDatabaseLoader();
    return loader.createLoader((connection, params) =>
        loader.compareAggregatedFacts(connection, params)
    );
};

const createCrossDatabaseSelectOptions = () => {
    const loader = new CrossDatabaseLoader();
    return loader.createLoader((connection, params) =>
        loader.crossDatabaseSelectOptions(connection, params)
    );
};

export {
    createCompareFacts,
    createCompareAggregatedFacts,
    createCrossDatabaseSelectOptions,
    CrossDatabaseLoader
};
