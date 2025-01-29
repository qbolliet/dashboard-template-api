// Importation des modules
const DataLoader = require('dataloader');

// Fonction de chargement des méta-données
const createDimensionLoader = () => new DataLoader(async (names) => {
    const db = await dbPool.acquire();
    try {
        return await Promise.all(names.map(async (name) => {
            const cacheKey = `dimension:${name}`;
            return await withCache(cacheKey, async () => {
                const query = `SELECT * FROM dim_${name}`;
                return await db.all(query);
            });
        }));
    } finally {
        dbPool.release(db);
    }
}, {
    maxBatchSize: 50
});

exports.createDimensionLoader = createDimensionLoader;