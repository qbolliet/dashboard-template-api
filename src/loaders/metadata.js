// loaders/metadata.js
const DataLoader = require('dataloader');
const { dbPool } = require('../db');
const { withCache } = require('../utils/cache');

// Fonction de chargement des méta-données
const createMetadataLoader = () => new DataLoader(async (names, fields) => {
    const db = await dbPool.acquire();
    try {
        const cacheKey = `metadata:${names.join(',')}`;
        return await withCache(cacheKey, async () => {
            const selectClause = fields.length > 0
                    ? fields.join(', ')
                    : '*';
            const placeholders = names.map(() => '?').join(',');
            const query = `SELECT ${selectClause} FROM metadata WHERE name IN (${placeholders})`;
            const results = await db.all(query, names);
            return names.map(name => results.find(r => r.name === name));
        });
    } finally {
        dbPool.release(db);
    }
}, {
    maxBatchSize: 100
});

exports.createMetadataLoader = createMetadataLoader;