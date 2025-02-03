// Importation des modules
const DataLoader = require('dataloader');
const { dbPool } = require('../db');
const { withCache } = require('../utils/cache');
const { buildWhereClause } = require('../utils/utils');

// Fonction d'importation des données
const createFactLoader = () => new DataLoader(async (keys) => {
    const db = await dbPool.acquire();
    try {
        return await Promise.all(keys.map(async ({ indicators, filters, structuredFilters, limit, offset, sort }) => {
            const cacheKey = `facts:${JSON.stringify({ indicators, filters, structuredFilters, limit, offset, sort })}`;
            return await withCache(cacheKey, async () => {
                const selectClause = indicators.length > 0
                    ? indicators.join(', ')
                    : '*';
                const whereClause = buildWhereClause(filters, structuredFilters);
                const sortClause = sort.length > 0 
                    ? `ORDER BY ${sort.map(s => `${s.field} ${s.order}`).join(', ')}` 
                    : '';
                const query = `
                    SELECT ${selectClause} FROM fact_table
                    ${whereClause} 
                    ${sortClause}
                    LIMIT ${limit} OFFSET ${offset}
                `;
                return await db.all(query);
            });
        }));
    } finally {
        dbPool.release(db);
    }
}, {
    maxBatchSize: 20,
    cacheKeyFn: key => JSON.stringify(key)
});

exports.createFactLoader = createFactLoader;