// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { config } from '../../utils/config-loader.js';
import { attachScope, contextScope } from './scope.js';
import { filterOperationsOf, typeFamilyOf } from '../../utils/metadata-mapping.js';
import type { MetadataResolvers, QueryResolvers } from '../../generated/graphql.js';

// Construction d'un resolver pour les méta-données
/**
 * Resolvers for metadata queries.
 *
 * Handles the retrieval of metadata information from the database
 * using the per-request DataLoader for batching and caching, and derives
 * `typeFamily` / `filterOperations` on every Metadata object from its SQL type.
 */
const metadataResolvers: {
  Metadata: Pick<MetadataResolvers, 'typeFamily' | 'filterOperations'>;
  Query: Pick<QueryResolvers, 'getMetaData'>;
} = {
  // Champs dérivés de sqlType, résolus sur tout Metadata quel que soit le chemin qui
  // l'a produit : aucune requête, et indépendants des lignes déjà en cache Redis
  Metadata: {
    /**
     * Resolves the type family of the column, from its SQL type.
     *
     * @param parent - Metadata row of the column.
     * @returns The TypeFamily enum value.
     */
    typeFamily: (parent) => typeFamilyOf(parent.sqlType),

    /**
     * Resolves the filter operations the filter compiler accepts on the column.
     *
     * @param parent - Metadata row of the column.
     * @returns The allowed FilterOperation values.
     */
    filterOperations: (parent) => filterOperationsOf(parent.sqlType),
  },

  Query: {
    /**
     * Fetches metadata for a given field name.
     * Arguments follow the generated `QueryGetMetaDataArgs`.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param context - GraphQL context with loaders.
     * @returns Metadata row for the requested field (carrying its catalog and
     *   schema for the lazy `stats` field), or null if not found.
     */
    getMetaData: async (_, { name, catalog, schema }, context) => {
      // Sélection du loader adapté au catalogue/schéma cible
      const targetLoaders = context.getLoadersForCatalog(catalog, schema);
      const loader = targetLoaders ? targetLoaders.metadata : context.loaders.metadata;

      const row = await withTimeout(
        loader.load(name),
        config.API.TIMEOUTS.METADATA,
        'Metadata fetch timeout',
      );
      // Catalogue et schéma rattachés pour la résolution paresseuse de `stats`
      return attachScope(row, contextScope(catalog, schema));
    },
  },
};

export { metadataResolvers };
