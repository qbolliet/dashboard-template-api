// Importation des modules
// loaders/aggregated-facts.js
const DataLoader = require('dataloader');
const { dbPool } = require('../db');
const { withCache } = require('../utils/cache');
const { buildWhereClause } = require('../utils/utils');

// Loder de la table agrégée
const createAggregatedFactsLoader = () => new DataLoader(async (keys) => {
    const db = await dbPool.acquire();
    try {
        return await Promise.all(keys.map(async ({ 
            fields, 
            filters, 
            structuredFilters, 
            groupBy, 
            aggregation,
            limit,
            offset,
            sort = [],
        }) => {
            const cacheKey = `aggregated-facts:${JSON.stringify({ 
                fields, 
                filters, 
                structuredFilters, 
                groupBy, 
                aggregation,
                limit,
                offset,
                sort 
            })}`;

            return await withCache(cacheKey, async () => {
                const whereClause = buildWhereClause(filters, structuredFilters);
                
                // Map aggregation functions to SQL
                const aggregationMap = {
                    SUM: 'SUM',
                    AVG: 'AVG',
                    MAX: 'MAX',
                    MIN: 'MIN',
                    COUNT: 'COUNT',
                    MEDIAN: 'PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value)',
                    MODE: 'MODE'
                };

                const aggregationQuery = aggregationMap[aggregation] || 'SUM';

                // Build sorting clause
                const sortClause = sort.length > 0 
                    ? `ORDER BY ${sort.map(s => 
                        s.field === 'key' ? 'key' : `aggregatedValue ${s.order}`
                    ).join(', ')}` 
                    : '';

                const query = `
                    SELECT 
                        ${groupBy} as key, 
                        ${aggregationQuery}(value) as aggregatedValue,
                        COUNT(*) as count
                    FROM fact_table
                    ${whereClause}
                    GROUP BY ${groupBy}
                    ${sortClause}
                    LIMIT ${limit} OFFSET ${offset}
                `;

                const results = await db.all(query);
                
                // Add additional statistics if needed
                return results.map(row => ({
                    ...row,
                    key: String(row.key),
                    aggregatedValue: Number(row.aggregatedValue),
                    count: Number(row.count)
                }));
            });
        }));
    } finally {
        dbPool.release(db);
    }
}, {
    maxBatchSize: 20,
    cacheKeyFn: key => JSON.stringify(key)
});

module.exports = { createAggregatedFactsLoader };