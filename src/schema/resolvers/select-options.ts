// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { config } from '../../utils/config-loader.js';
import { DEFAULT_TREE_MAX_NODES } from '../../loaders/select-options.js';
import { indexMetadataByName, resolveLabelField } from '../../utils/metadata-mapping.js';
import { validatePagination } from '../../utils/pagination.js';
import { compileScopeFilter } from './scope.js';
import type { SelectOptionNode } from '../../loaders/select-options.js';
import type { CompiledFilter } from '../../utils/filter-tree.js';
import type { QueryResolvers } from '../../generated/graphql.js';

/**
 * Builds the loader-key fragment carrying the compiled filter.
 *
 * A null `where` must not appear in the key at all: the cache key hashes the
 * key object, and `where: null` would differ from an absent field, so a
 * request without filter would stop sharing the entries it had before.
 *
 * @param where - Compiled filter, or null when the request has none.
 * @returns `{ where }` when there is a filter, an empty object otherwise.
 */
// Fragment de clé du loader : le filtre n'y figure que s'il existe
function whereKey(where: CompiledFilter | null): { where?: CompiledFilter } {
  return where && where.sql ? { where } : {};
}

// Resolver pour la sélection des options
/**
 * Resolvers for select options queries.
 *
 * Provides field values for dropdown menus (flat list of one column) and
 * nested option trees of column hierarchies, both with optional
 * case-insensitive search via searchTerm.
 */
const selectOptionsResolvers: {
  Query: Pick<QueryResolvers, 'getSelectOptions' | 'getSelectOptionsTree'>;
} = {
  Query: {
    /**
     * Fetches available options for a single field.
     * Arguments follow the generated `QueryGetSelectOptionsArgs`.
     *
     * The effective label column is resolved here, by resolveLabelField on the
     * metadata of the field (read with its label columns): it is then part of
     * the loader key, hence of the cache key — two requests rendering the same
     * codes with different labels never share a cache entry.
     *
     * @param _ - Parent resolver result (unused at root).
     * @returns Array of select option objects.
     */
    getSelectOptions: async (
      _: unknown,
      {
        fieldName,
        limit = config.API.PAGINATION.SELECT_OPTIONS_LIMIT,
        searchTerm = '',
        labelField = null,
        catalog,
        schema,
        structuredFilters,
      },
      { loaders, getLoadersForCatalog },
    ) => {
      // Borne du nombre d'options, validée avant tout accès à la base
      const effectiveLimit = limit ?? config.API.PAGINATION.SELECT_OPTIONS_LIMIT;
      validatePagination(effectiveLimit);

      // Sélection des loaders adaptés au catalogue/schéma cible
      const activeLoaders = getLoadersForCatalog(catalog, schema) ?? loaders;

      // Colonne de libellés effective ; champ inconnu : le loader lève l'erreur
      const fieldMeta = await withTimeout(
        activeLoaders.metadata.load(fieldName),
        config.API.TIMEOUTS.METADATA,
        'Metadata fetch timeout',
      );
      const effectiveLabelField = fieldMeta
        ? resolveLabelField(fieldName, indexMetadataByName([fieldMeta]), labelField)
        : null;

      // Même validation et même compilation que getFieldStats : SQL paramétré, jamais de SQL client
      const where = await compileScopeFilter(activeLoaders, structuredFilters);

      return withTimeout(
        activeLoaders.selectOptions.load({
          fieldName,
          limit: effectiveLimit,
          searchTerm,
          labelField: effectiveLabelField,
          // Absent sans filtre : la clé, donc le SQL et le cache, restent ceux d'avant
          ...whereKey(where),
        }),
        config.API.TIMEOUTS.SELECT_OPTIONS,
        'Select options fetch timeout',
      );
    },

    /**
     * Fetches the nested option tree of a column hierarchy.
     * Arguments follow the generated `QueryGetSelectOptionsTreeArgs`.
     *
     * @param _ - Parent resolver result (unused at root).
     * @returns Forest of `{ value, label, children? }` nodes.
     */
    getSelectOptionsTree: async (
      _: unknown,
      { fieldName, maxDepth = null, searchTerm = null, catalog, schema, structuredFilters },
      { loaders, getLoadersForCatalog },
    ): Promise<SelectOptionNode[]> => {
      // Sélection des loaders adaptés au catalogue/schéma cible
      const targetLoaders = getLoadersForCatalog(catalog, schema) ?? loaders;

      // La borne fait partie de la clé : un arbre en cache ne la contourne jamais
      const maxNodes = config.API.SELECT_OPTIONS?.TREE_MAX_NODES ?? DEFAULT_TREE_MAX_NODES;

      // Même validation et même compilation que getFieldStats : SQL paramétré, jamais de SQL client
      const where = await compileScopeFilter(targetLoaders, structuredFilters);

      return withTimeout(
        targetLoaders.selectOptionsTree.load({
          fieldName,
          maxDepth,
          searchTerm: searchTerm || null,
          maxNodes,
          // Absent sans filtre : la clé, donc le SQL et le cache, restent ceux d'avant
          ...whereKey(where),
        }),
        config.API.TIMEOUTS.SELECT_OPTIONS,
        'Select options tree fetch timeout',
      );
    },
  },
};

export { selectOptionsResolvers };
