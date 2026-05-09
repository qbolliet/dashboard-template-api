// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { config } from '../../utils/config-loader.js';
import type { GraphQLContext } from './types.js';

// ─── Interfaces des arguments ─────────────────────────────────────────────────

/** Arguments for the getMetaData query. */
export interface MetadataArgs {
    name: string;
    database?: string | null;
}

// Construction d'un resolver pour les méta-données
/**
 * Resolvers for metadata queries.
 *
 * Handles the retrieval of metadata information from the database
 * using the per-request DataLoader for batching and caching.
 */
const metadataResolvers = {
    Query: {
        /**
         * Fetches metadata for a given field name.
         * Arguments follow {@link MetadataArgs}.
         *
         * @param _ - Parent resolver result (unused at root).
         * @returns Metadata row for the requested field, or null if not found.
         */
        getMetaData: async (
            _: unknown,
            { name, database }: MetadataArgs,
            { loaders, getLoadersForDatabase }: GraphQLContext
        ) => {
            // Sélection du loader adapté à la base de données cible
            const targetLoaders = getLoadersForDatabase(database);
            const loader = targetLoaders ? targetLoaders.metadata : loaders.metadata;

            return withTimeout(
                loader.load(name),
                config.API.TIMEOUTS.METADATA,
                'Metadata fetch timeout'
            );
        }
    }
};

export { metadataResolvers };
