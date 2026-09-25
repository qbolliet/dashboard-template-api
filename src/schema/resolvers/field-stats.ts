// Importation des modules
import { GraphQLError } from 'graphql';
import { withTimeout } from '../../utils/timeout.js';
import { config } from '../../utils/config-loader.js';
import { compileFilterTree } from '../../utils/filter-tree.js';
import { validateIdentifier } from '../../utils/utils.js';
import { contextScope, loadersForScope } from './scope.js';
import type { GraphQLContext } from './types.js';
import type { FieldScope, ScopeFields } from './scope.js';
import type { FieldStats } from '../../loaders/field-stats.js';
import type { FieldMetadata } from '../../utils/metadata-mapping.js';
import type { FilterNodeInput } from '../../utils/filter-tree.js';

// ─── Interfaces des arguments ─────────────────────────────────────────────────

/** Arguments for the getFieldStats query. */
export interface FieldStatsArgs {
  fieldName: string;
  catalog?: string | null;
  schema?: string | null;
  structuredFilters?: FilterNodeInput | null;
}

// ─── Fonction utilitaire ──────────────────────────────────────────────────────

/**
 * Loads the statistics of one column of a scope, optionally filtered.
 *
 * The column is checked against the metadata table first: an unknown column is
 * a client error (BAD_USER_INPUT) and must not reach the SQL, where it would
 * only surface as a binder error swallowed by the loader's generic handling.
 * The metadata read goes through the metadata DataLoader, already warm when the
 * column comes from a `Metadata` object.
 *
 * @param context - GraphQL context of the request.
 * @param scope - Effective catalog and schema of the column.
 * @param fieldName - Column to describe.
 * @param structuredFilters - Filter tree restricting the rows, or null for the whole table.
 * @returns The statistics of the column.
 * @throws {GraphQLError} BAD_USER_INPUT when the column or the filter tree is invalid.
 */
// Statistiques d'une colonne d'un scope, après contrôle de son existence
async function loadFieldStats(
  context: GraphQLContext,
  scope: FieldScope,
  fieldName: string,
  structuredFilters: FilterNodeInput | null | undefined,
): Promise<FieldStats> {
  validateIdentifier(fieldName, 'field');
  // Instanciation des loaders
  const loaders = loadersForScope(context, scope);

  // Requête du champ dans les métadonnées
  const meta = await withTimeout(
    loaders.metadata.load(fieldName),
    config.API.TIMEOUTS.METADATA,
    'Metadata fetch timeout',
  );
  if (!meta) {
    throw new GraphQLError(
      `Unknown field "${fieldName}" in schema '${scope.schema}' of catalog '${scope.catalog}'.`,
      { extensions: { code: 'BAD_USER_INPUT' } },
    );
  }

  // Même compilation que les requêtes de faits : SQL paramétré, jamais de SQL client
  const where = await compileFilterTree(structuredFilters, (names) =>
    loaders.metadata.loadMany(names),
  );

  return withTimeout(
    loaders.fieldStats.load({ fieldName, where }),
    config.API.TIMEOUTS.AGGREGATED_SIMPLE,
    'Field stats fetch timeout',
  );
}

// Construction des resolvers pour les statistiques de colonne
/**
 * Resolvers for column statistics.
 *
 * `Metadata.stats` is a lazy field resolver: the query only runs when the
 * client selects it, one SQL query per column (N columns = N queries, which
 * the complexity scores of config/security.yaml account for).
 * `getFieldStats` is the same computation addressable directly, with a filter
 * tree to recalibrate sliders after the current filters are applied.
 */
const fieldStatsResolvers = {
  Metadata: {
    /**
     * Resolves the statistics of the column this Metadata object describes.
     *
     * The parent carries the internal `_catalog` / `_schema` fields attached by
     * every resolver that produces a Metadata (not exposed in the SDL); without
     * them the target of the query would be ambiguous, so it fails explicitly.
     *
     * @param parent - Metadata row with its catalog and schema.
     * @param _ - Field arguments (none).
     * @param context - GraphQL context with loaders.
     * @returns Unfiltered statistics of the column.
     * @throws {GraphQLError} When the parent has no catalog/schema attached.
     */
    // Statistiques non filtrées de la colonne décrite par le parent
    stats: async (
      parent: FieldMetadata & ScopeFields,
      _: Record<string, never>,
      context: GraphQLContext,
    ): Promise<FieldStats> => {
      if (!parent._catalog || !parent._schema) {
        throw new GraphQLError(
          `Stats are unavailable for "${parent.name}": the Metadata object carries no catalog/schema.`,
          { extensions: { code: 'INTERNAL_SERVER_ERROR' } },
        );
      }
      return loadFieldStats(
        context,
        { catalog: parent._catalog, schema: parent._schema },
        parent.name,
        null,
      );
    },
  },

  Query: {
    /**
     * Fetches the statistics of a column, optionally restricted by a filter tree.
     * Arguments follow {@link FieldStatsArgs}.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param args - Column, catalog/schema routing and optional filter tree.
     * @param context - GraphQL context with loaders.
     * @returns Min, max, distinct count and NULL count of the column.
     * @throws {GraphQLError} BAD_USER_INPUT on an unknown column or an invalid filter tree.
     */
    // Statistiques d'une colonne, éventuellement recalculées sous filtres
    getFieldStats: async (
      _: unknown,
      { fieldName, catalog, schema, structuredFilters }: FieldStatsArgs,
      context: GraphQLContext,
    ): Promise<FieldStats> =>
      loadFieldStats(context, contextScope(context, catalog, schema), fieldName, structuredFilters),
  },
};

export { fieldStatsResolvers };
