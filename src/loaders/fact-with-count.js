// Importation des modules

// Fonction additionnelle avec comptage des observations et support pour la pagination
/**
 * Fact resolver with additional count query and pagination support
 * @param {Object} args - Query arguments
 * @returns {Promise<Object>} Results with data, total count and pagination info
 */
const getFactTableWithCount = async (args) => {
    // Utilisation du loader
    const factLoader = createFactLoader();
    const data = await factLoader.load(args);

    // Gestion du compte avec cache
    const countKey = `count:${JSON.stringify({
        filters: args.filters,
        structuredFilters: args.structuredFilters
    })}`;
    
    let total = await redis.get(countKey);

    if (!total) {
        // Si pas en cache, calculer
        const loader = new FactLoader();
        total = await loader.executeWithConnection(async (connection) => {
            return loader.getCount(connection, args);
        });
        
        // Mise en cache du résultat
        try {
            await redis.set(countKey, total, 'EX', 300);
        } catch (cacheError) {
            console.warn('Failed to cache count:', cacheError);
        }
    } else {
        total = parseInt(total);
    }

    // Construction du résultat selon le format
    if (args.format === 'metadata') {
        // Pour le format D3, inclure les infos de pagination dans les métadonnées
        return {
            ...data,
            metadata: {
                ...data.metadata,
                total: parseInt(total),
                hasNextPage: args.offset + args.limit < parseInt(total),
                currentPage: Math.floor(args.offset / args.limit) + 1,
                totalPages: Math.ceil(parseInt(total) / args.limit)
            }
        };
    } else {
        // Format standard avec informations de pagination
        return {
            data: Array.isArray(data) ? data : (data && data.data ? data.data : []),
            total: parseInt(total),
            hasNextPage: args.offset + args.limit < parseInt(total),
            currentPage: Math.floor(args.offset / args.limit) + 1,
            totalPages: Math.ceil(parseInt(total) / args.limit)
        };
    }
};

export { getFactTableWithCount };