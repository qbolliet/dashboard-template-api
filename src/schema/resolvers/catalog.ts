// Importation des modules
import { GraphQLError } from 'graphql';
import { databaseManager } from '../../db/index.js';
import type { GraphQLContext } from './types.js';
import type { CatalogMetadataRow } from '../../loaders/catalog.js';

// ─── Interfaces des arguments ─────────────────────────────────────────────────

/** Arguments de la requête getDatabaseSchema. */
export interface DatabaseSchemaArgs {
    database: string;
}

/** Arguments de la requête getSharedDimensions. */
export interface SharedDimensionsArgs {
    databases: string[];
}

// ─── Interfaces des résultats ─────────────────────────────────────────────────

/** Entrée du catalogue d'une base de données (schéma + dimensions). */
export interface DatabaseCatalogEntry {
    id: string;
    fields: CatalogMetadataRow[];
    dimensionNames: string[];
}

// Construction d'un resolver pour le catalogue multi-bases
/**
 * Resolvers for database catalog queries.
 *
 * Exposes the list of available databases, their schemas, and shared
 * dimensions across multiple databases for cross-database analysis.
 */
const catalogResolvers = {
    Query: {
        /**
         * Lists all available databases with their schemas and dimension names.
         *
         * Loads catalog metadata and dimension names for each database in
         * parallel, using empty arrays as graceful fallbacks on error.
         *
         * Args:
         *     _: Parent resolver result (unused at root).
         *     __: Query arguments (none).
         *     context: GraphQL context with loaders.
         *
         * Returns:
         *     Array of database catalog entries.
         */
        // Listage de toutes les bases de données disponibles avec leur schéma
        getDatabases: async (
            _: unknown,
            __: Record<string, never>,
            { loaders }: GraphQLContext
        ): Promise<DatabaseCatalogEntry[]> => {
            const databases = databaseManager.getAvailableDatabases() as string[];

            return Promise.all(
                databases.map(async (id) => {
                    let fields: CatalogMetadataRow[];
                    let dimensionNames: string[];

                    // Chargement du schéma avec fallback sur tableau vide en cas d'erreur
                    try {
                        fields = await loaders.catalogMetadata.load(id);
                    } catch {
                        fields = [];
                    }

                    // Chargement des noms de dimensions avec fallback sur tableau vide
                    try {
                        dimensionNames = await loaders.catalogDimensionNames.load(id);
                    } catch {
                        dimensionNames = [];
                    }

                    return { id, fields: fields ?? [], dimensionNames: dimensionNames ?? [] };
                })
            );
        },

        /**
         * Fetches the schema (field list) of a specific database.
         *
         * Args:
         *     _: Parent resolver result (unused at root).
         *     database: Database alias to query.
         *     context: GraphQL context with loaders.
         *
         * Returns:
         *     Array of catalog metadata rows describing the database schema.
         */
        // Récupération du schéma d'une base de données spécifique
        getDatabaseSchema: async (
            _: unknown,
            { database }: DatabaseSchemaArgs,
            { loaders }: GraphQLContext
        ): Promise<CatalogMetadataRow[]> => {
            const targetDb = databaseManager.validateDatabaseRouting(database) as string;
            return loaders.catalogMetadata.load(targetDb);
        },

        /**
         * Finds dimension names that are shared across all specified databases.
         *
         * Validates each database alias before loading, then intersects the
         * dimension name sets to return only the common dimensions.
         *
         * Args:
         *     _: Parent resolver result (unused at root).
         *     databases: List of database aliases to compare.
         *     context: GraphQL context with loaders.
         *
         * Returns:
         *     Array of dimension names present in every specified database.
         *
         * Raises:
         *     GraphQLError: When databases is empty or contains invalid aliases.
         */
        // Calcul de l'intersection des dimensions partagées entre plusieurs bases
        getSharedDimensions: async (
            _: unknown,
            { databases }: SharedDimensionsArgs,
            { loaders }: GraphQLContext
        ): Promise<string[]> => {
            // Validation de la présence d'au moins une base de données
            if (!databases || databases.length === 0) {
                throw new GraphQLError('At least one database must be specified');
            }

            // Validation de chaque identifiant de base de données
            databases.forEach((db) => {
                if (!databaseManager.isValidDatabase(db)) {
                    throw new GraphQLError(
                        `Database '${db}' is not available. Available: ${(databaseManager.getAvailableDatabases() as string[]).join(', ')}`
                    );
                }
            });

            const dimensionSets = await Promise.all(
                databases.map((db) => loaders.catalogDimensionNames.load(db))
            );

            if (dimensionSets.length === 0) return [];

            // Intersection des ensembles de dimensions
            const [first, ...rest] = dimensionSets;
            return first.filter((dim) => rest.every((set) => set.includes(dim)));
        }
    }
};

export { catalogResolvers };
