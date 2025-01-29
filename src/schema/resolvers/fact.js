// Importation des modules
const { withTimeout } = require('../../utils/timeout');
const { buildWhereClause } = require('../../utils/utils');

// Construction d'un resolver pour la table des données
const factResolvers = {
    Query: {
        getFactTable: async (_, args, { loaders }) => {
            const data = await withTimeout(
                loaders.fact.load(args),
                10000,
                'Fact table fetch timeout'
            );

            const countKey = `count:${JSON.stringify(args)}`;
            let total = await redis.get(countKey);

            if (!total) {
                const db = await dbPool.acquire();
                try {
                    const whereClause = buildWhereClause(args.filters, args.structuredFilters);
                    const countQuery = `SELECT COUNT(*) as total FROM fact_table ${whereClause}`;
                    const result = await db.all(countQuery);
                    total = result[0].total;
                    await redis.set(countKey, total, 'EX', 300);
                } finally {
                    dbPool.release(db);
                }
            }

            return {
                data,
                total: parseInt(total),
                hasNextPage: args.offset + args.limit < parseInt(total)
            };
        }
    }
};

exports.factResolvers = factResolvers