// Importation des modules
const DataLoader = require('dataloader');
const { dbPool } = require('../db');
const { withCache } = require('../utils/cache');

// Fonction d'importation des options de sélection
const createSelectOptionsLoader = () => new DataLoader(async (keys) => {
    const db = await dbPool.acquire();
    try {
        return await Promise.all(keys.map(async ({ fieldName, limit, searchTerm }) => {
            const cacheKey = `select-options:${JSON.stringify({ fieldName, limit, searchTerm })}`;
            return await withCache(cacheKey, async () => {
                const [metadataRow] = await db.all(
                    'SELECT is_categorical FROM metadata WHERE name = ?', 
                    [fieldName]
                );

                if (metadataRow?.is_categorical) {
                    let query = `SELECT value, label FROM dim_${fieldName}`;
                    const params = [];

                    if (searchTerm) {
                        query += ' WHERE LOWER(label) LIKE LOWER(?)';
                        params.push(`%${searchTerm}%`);
                    }

                    query += ' LIMIT ?';
                    params.push(limit);

                    const results = await db.all(query, params);
                    return results.map(row => ({
                        value: String(row.value),
                        label: row.label
                    }));
                }

                let query = `SELECT DISTINCT ${fieldName} as value FROM fact_table`;
                const params = [];

                if (searchTerm) {
                    query += ' WHERE CAST(value AS VARCHAR) LIKE ?';
                    params.push(`%${searchTerm}%`);
                }

                query += ' LIMIT ?';
                params.push(limit);

                const results = await db.all(query, params);
                return results.map(row => ({
                    value: String(row.value),
                    label: String(row.value)
                }));
            });
        }));
    } finally {
        dbPool.release(db);
    }
}, {
    maxBatchSize: 50,
    cacheKeyFn: key => JSON.stringify(key)
});

exports.createSelectOptionsLoader = createSelectOptionsLoader;