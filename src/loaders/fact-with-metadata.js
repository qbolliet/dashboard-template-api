// Importation des modules
import { FactQueryLoader } from './base-loader.js';
import { buildWhereClause } from '../utils/utils.js';

// Classe de chargement de la table des faits avec des méta-données utiles pour la création de graphiques D3
/**
 * Loader spécialisé pour les faits avec métadonnées D3
 */
class FactWithMetadataLoader extends FactQueryLoader {
    // Initialisation
    constructor() {
        super({
            batchSize: 5,
            cachePrefix: 'facts-metadata',
            cache: true,
            cacheTimeout: 300
        });
    }

    // Méthode de chargement avec des méta-données
    async loadFactsWithMetadata(connection, params) {
        const { fields, filters, structuredFilters, limit, offset, sort } = params;
        
        // Validation
        this.validatePagination(limit, offset);
        
        // Construction de la requête
        const selectClause = this.buildSelectClause(fields);
        const whereClause = buildWhereClause(filters, structuredFilters);
        const sortClause = this.buildSortClause(sort);
        
        const query = `
            SELECT ${selectClause} FROM fact_table
            ${whereClause} 
            ${sortClause}
            LIMIT ${limit} OFFSET ${offset}
        `;
        
        // Récupération avec métadonnées D3
        const result = await connection.getWithMetadata(query);
        
        // Enrichissement avec count total et pagination
        const countQuery = `SELECT COUNT(*) as total FROM fact_table ${whereClause}`;
        const countResult = await connection.all(countQuery);
        const total = countResult[0].total;
        
        return {
            ...result,
            metadata: {
                ...result.metadata,
                total,
                hasNextPage: offset + limit < total,
                currentPage: Math.floor(offset / limit) + 1,
                totalPages: Math.ceil(total / limit)
            }
        };
    }
}

// Fonction de création d'un loader de la table des faits avec des méta-données
const createFactWithMetadataLoader = () => {
    const loader = new FactWithMetadataLoader();
    return loader.createLoader(
        (connection, params) => loader.loadFactsWithMetadata(connection, params)
    );
}

export { createFactWithMetadataLoader } ;