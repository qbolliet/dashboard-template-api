// Importation des modules
import { BaseQueryLoader } from './base-loader.js';
import { config } from '../utils/config-loader.js';
import { validateIdentifier } from '../utils/utils.js';
import type { DuckDBConnection } from './base-loader.js';

// ─── Interfaces des options de sélection ─────────────────────────────────────

/** Parameters for a select options query. */
interface SelectOptionsParams {
    fieldName: string;
    limit: number;
    searchTerm?: string | null;
}

/** Select option with value and label. */
interface SelectOption {
    value: string;
    label: string;
}

// Classe de chargement des options de sélection
/**
 * Loader for select option queries (dropdown values).
 *
 * Automatically routes the query to a dimension table when the field is
 * categorical, or to the fact table for distinct value extraction otherwise.
 */
class SelectOptionsLoader extends BaseQueryLoader {

    // Initialisation avec la configuration spécifique aux options de sélection
    /**
     * Creates a SelectOptionsLoader bound to a specific database.
     *
     * @param databaseId - Catalog alias to query; null uses the default database.
     */
    constructor(databaseId: string | null = null) {
        super({
            batchSize: config.API.LOADERS.BATCH_SIZE,
            cachePrefix: 'select-options',
            cache: true,
            // Durée de mise en cache plus longue car les options changent peu
            cacheTimeout: config.API.LOADERS.SELECT_OPTIONS_CACHE_TIMEOUT,
            databaseId
        });
    }

    // Méthode de chargement des options de sélection selon le type du champ
    /**
     * Loads select options for a given field.
     *
     * Checks the metadata table to determine whether the field is categorical,
     * then delegates to loadFromDimension or loadFromFacts accordingly.
     *
     * @param connection - Active DuckDB connection from the pool.
     * @param params - Object with fieldName, limit, and optional searchTerm.
     * @returns Array of SelectOption objects, or empty array on error.
     */
    async loadSelectOptions(
        connection: DuckDBConnection,
        { fieldName, limit, searchTerm }: SelectOptionsParams
    ): Promise<SelectOption[]> {
        try {
            validateIdentifier(fieldName, 'fieldName');

            // Vérification si le champ est catégoriel via la table metadata
            const metadataQuery = `SELECT is_categorical FROM ${this.qualifyTable('metadata')} WHERE name = ?`;
            const metadataResults = await connection.all(metadataQuery, [fieldName]);
            const isCategorical = metadataResults.length > 0 && metadataResults[0].is_categorical;

            if (isCategorical) {
                // Chargement depuis la table de dimension associée
                return await this.loadFromDimension(connection, fieldName, limit, searchTerm);
            } else {
                // Chargement des valeurs distinctes depuis la table des faits
                return await this.loadFromFacts(connection, fieldName, limit, searchTerm);
            }
        } catch {
            return [];
        }
    }

    // Méthode de chargement depuis la table des dimensions
    /**
     * Loads options from the dimension table for a categorical field.
     *
     * @param connection - Active DuckDB connection from the pool.
     * @param fieldName - Name of the categorical field (table: dim_{fieldName}).
     * @param limit - Maximum number of options to return.
     * @param searchTerm - Optional substring filter applied to the label column.
     * @returns Array of SelectOption with value and label from the dimension table.
     */
    private async loadFromDimension(
        connection: DuckDBConnection,
        fieldName: string,
        limit: number,
        searchTerm?: string | null
    ): Promise<SelectOption[]> {
        // Construction de la requête avec filtre optionnel
        let query = `SELECT value, label FROM ${this.qualifyTable(`dim_${fieldName}`)}`;
        const params: unknown[] = [];

        // Ajout du terme de recherche si présent (insensible à la casse)
        if (searchTerm) {
            query += ' WHERE LOWER(label) LIKE LOWER(?)';
            params.push(`%${searchTerm}%`);
        }

        // Application de la limite
        query += ' LIMIT ?';
        params.push(limit);

        // Exécution de la requête
        const results = await connection.all(query, params);

        // Normalisation des valeurs en chaînes de caractères
        return results.map(row => ({
            value: String(row.value),
            label: row.label as string
        }));
    }

    // Méthode de chargement depuis la table des faits
    /**
     * Loads distinct field values from the fact table for a non-categorical field.
     *
     * @param connection - Active DuckDB connection from the pool.
     * @param fieldName - Name of the field to extract distinct values from.
     * @param limit - Maximum number of options to return.
     * @param searchTerm - Optional substring filter on the cast value string.
     * @returns Array of SelectOption where value and label are both the raw value.
     */
    private async loadFromFacts(
        connection: DuckDBConnection,
        fieldName: string,
        limit: number,
        searchTerm?: string | null
    ): Promise<SelectOption[]> {
        // Construction de la requête avec filtrage optionnel
        let query = `SELECT DISTINCT ${fieldName} as value FROM ${this.qualifyTable('fact_table')}`;
        const params: unknown[] = [];

        // Ajout du terme de recherche si présent
        if (searchTerm) {
            query += ` WHERE CAST(${fieldName} AS VARCHAR) LIKE ?`;
            params.push(`%${searchTerm}%`);
        }

        // Application de la limite
        query += ' LIMIT ?';
        params.push(limit);

        // Exécution de la requête
        const results = await connection.all(query, params);

        // Valeur brute utilisée comme libellé pour les champs non catégoriels
        return results.map(row => ({
            value: String(row.value),
            label: String(row.value)
        }));
    }
}

// Fonction de création d'un loader pour les options de sélection
/**
 * Creates a DataLoader for select option queries.
 *
 * @param databaseId - Catalog alias to query; null uses the default database.
 * @returns DataLoader keyed by SelectOptionsParams, returning SelectOption arrays.
 */
const createSelectOptionsLoader = (databaseId: string | null = null) => {
    const loader = new SelectOptionsLoader(databaseId);
    return loader.createLoader<SelectOptionsParams, SelectOption[]>(
        (connection, params) => loader.loadSelectOptions(connection, params)
    );
};

export { createSelectOptionsLoader };
export type { SelectOptionsParams, SelectOption };
