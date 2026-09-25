// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { partitionFacts } from '../../utils/fact-partition.js';
import { config } from '../../utils/config-loader.js';
import { GraphQLError } from 'graphql';
import { compileFilterTree } from '../../utils/filter-tree.js';
import { resolveEffectiveSort } from '../../utils/default-sort.js';
import { databaseManager } from '../../db/index.js';
import { attachScopeToAll, contextScope } from './scope.js';
import type { FieldScope } from './scope.js';
import type { GraphQLContext } from './types.js';
import type { FactQueryParams } from '../../loaders/fact.js';
import type { LoadersCollection } from '../../loaders/index.js';
import type { FieldMetadata } from '../../utils/metadata-mapping.js';
import type { FilterNodeInput } from '../../utils/filter-tree.js';

// ─── Interfaces des arguments ─────────────────────────────────────────────────

/** Common arguments for fact table queries, including catalog/schema routing. */
export interface FactTableArgs extends Omit<FactQueryParams, 'where' | 'format'> {
  structuredFilters?: FilterNodeInput | null;
  format?: 'OBJECTS' | 'ARRAYS' | null;
  catalog?: string | null;
  schema?: string | null;
}

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

/**
 * Builds the fact loader parameters from the GraphQL arguments.
 *
 * The filter tree is validated and compiled into a parameterized predicate
 * using the metadata of the target catalog/schema, and the effective sort is
 * resolved from dataset_metadata.cluster_by when the client gave none. Only
 * concrete values reach the loader, so the DataLoader/Redis cache key derives
 * from a deterministic SQL string, parameter list and ordering.
 *
 * @param args - GraphQL arguments of the fact query.
 * @param activeLoaders - Loaders bound to the target catalog/schema.
 * @returns Parameters for the fact loaders.
 * @throws {GraphQLError} BAD_USER_INPUT when the filter tree is invalid.
 */
// Construction des paramètres du loader et compilation de l'arbre de filtres
async function buildFactParams(
  args: FactTableArgs,
  activeLoaders: LoadersCollection,
): Promise<FactQueryParams> {
  const where = await compileFilterTree(args.structuredFilters, (names) =>
    activeLoaders.metadata.loadMany(names),
  );

  // Tri effectif résolu ici, donc présent dans les paramètres du loader et
  // dans la clé de cache : deux pages ne peuvent pas partager une entrée.
  const targetCatalog = databaseManager.validateCatalogRouting(args.catalog ?? null);
  const sort = await resolveEffectiveSort(args.sort, activeLoaders, targetCatalog, args.schema);

  return {
    fields: args.fields,
    where,
    limit: args.limit,
    offset: args.offset,
    sort,
  };
}

// ─── Interfaces des résultats enrichis ───────────────────────────────────────

/** Paginated result from a fact table query. */
export interface PaginatedFactResult {
  data: Record<string, unknown>[];
  total: number;
  hasNextPage: boolean;
  currentPage: number;
  totalPages: number;
  generatedAt: string;
  columns?: string[];
}

/**
 * Parent object of DatasetWithMetadata: the loaded page plus the metadata
 * loader of the target catalog/schema, so that `fields` is resolved lazily and
 * only when the client selects it.
 */
export interface DatasetSource {
  columns?: string[];
  metadataLoader?: LoadersCollection['metadata'];
  /** Catalog and schema the page was read from, carried to the lazy `stats` of each field. */
  scope?: FieldScope;
  [key: string]: unknown;
}

// Construction de resolvers pour la table des données
/**
 * Resolvers for fact table queries.
 *
 * Handles the retrieval and formatting of fact data from the database,
 * including the key/measure partition of each row and D3-compatible
 * output formats.
 */
const factResolvers = {
  Query: {
    /**
     * Fetches a paginated page of fact rows, split into keys and measures.
     *
     * Validates the pagination parameters against configured limits before
     * issuing the DataLoader call, then partitions the columns of every
     * returned row in a single bulk pass.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param args - Fact query parameters including limit, offset and database.
     * @param context - GraphQL context with loaders.
     * @returns Paginated result object with enriched fact rows.
     * @throws {GraphQLError} When limit or offset exceed configured maximums,
     *   or when the filter tree is invalid (BAD_USER_INPUT).
     */
    // Requête standard des faits avec pagination et comptage
    getFactTable: async (
      _: unknown,
      args: FactTableArgs,
      { loaders, getLoadersForCatalog }: GraphQLContext,
    ) => {
      const { limit, offset } = args;

      // Validation de la limite de pagination
      if (limit > config.API.PAGINATION.MAX_LIMIT) {
        throw new GraphQLError(`Limit cannot exceed ${config.API.PAGINATION.MAX_LIMIT}`);
      }

      // Validation de l'offset de pagination
      if (offset > config.API.PAGINATION.MAX_OFFSET) {
        throw new GraphQLError(`Offset cannot exceed ${config.API.PAGINATION.MAX_OFFSET}`);
      }

      // Sélection des loaders adaptés au catalogue/schéma cible
      const targetLoaders = getLoadersForCatalog(args.catalog, args.schema);
      const activeLoaders = targetLoaders ?? loaders;
      const params = await buildFactParams(args, activeLoaders);

      const result = (await withTimeout(
        activeLoaders.factWithCount.load(params),
        config.API.TIMEOUTS.FACT_SIMPLE,
        'Fact table fetch timeout',
      )) as PaginatedFactResult;

      // Partition en masse des colonnes (clés / mesures) pour toutes les lignes
      if (result && result.data) {
        const partitionedData = await withTimeout(
          partitionFacts(result.data, activeLoaders),
          config.API.TIMEOUTS.FACT_COMPLEX,
          'Fact partition timeout',
        );

        return { ...result, data: partitionedData };
      }

      return result;
    },

    /**
     * Fetches fact rows with D3-compatible metadata, split into keys and measures.
     *
     * Supports the ARRAYS output format which transposes row objects into
     * column-ordered arrays for direct consumption by D3 charting code.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param args - Fact query parameters including optional format and database.
     * @param context - GraphQL context with loaders.
     * @returns Result with enriched data in the requested format.
     */
    // Requête des faits avec métadonnées optimisées pour D3
    getFactTableWithMetadata: async (_: unknown, args: FactTableArgs, context: GraphQLContext) => {
      // Sélection des loaders adaptés au catalogue/schéma cible
      const targetLoaders = context.getLoadersForCatalog(args.catalog, args.schema);
      const activeLoaders = targetLoaders ?? context.loaders;
      const params = await buildFactParams(args, activeLoaders);
      const scope = contextScope(context, args.catalog, args.schema);

      const result = (await withTimeout(
        activeLoaders.factWithMetadata.load(params),
        config.API.TIMEOUTS.FACT_SIMPLE,
        'Metadata fact table fetch timeout',
      )) as PaginatedFactResult;

      // Partition en masse des colonnes (clés / mesures) pour toutes les lignes
      if (result && result.data) {
        const partitionedData = await withTimeout(
          partitionFacts(result.data, activeLoaders),
          config.API.TIMEOUTS.FACT_COMPLEX,
          'Fact partition timeout',
        );

        // Format ARRAYS : transformation de [{col: val}] en [[val1, val2, ...]]
        // Les colonnes sont déjà présentes dans result.columns
        if (args.format === 'ARRAYS' && result.columns) {
          return {
            ...result,
            metadataLoader: activeLoaders.metadata,
            scope,
            data: partitionedData.map((row) =>
              result.columns!.map((col) => (row as Record<string, unknown>)[col] ?? null),
            ),
          };
        }

        return { ...result, metadataLoader: activeLoaders.metadata, scope, data: partitionedData };
      }

      return result;
    },
  },

  DatasetWithMetadata: {
    /**
     * Resolves the metadata of the returned columns, aligned on `columns`.
     *
     * Reads the metadata loader already used to compile the filters and to
     * partition the rows: no query beyond its cache. A column without a
     * metadata row cannot occur on a fact_table (the writer declares every
     * column), so it fails explicitly instead of leaving a hole in the array.
     *
     * @param parent - The loaded page, carrying its columns and metadata loader.
     * @returns One metadata row per column, same names and same order, each
     *   carrying the page's catalog and schema for the lazy `stats` field.
     * @throws {GraphQLError} When a returned column has no metadata row.
     */
    // Métadonnées des colonnes retournées, alignées sur `columns`
    fields: async (parent: DatasetSource): Promise<FieldMetadata[]> => {
      const { columns = [], metadataLoader, scope } = parent;
      if (!metadataLoader) {
        throw new GraphQLError('Column metadata is unavailable for this result');
      }

      const rows = await Promise.all(columns.map((column) => metadataLoader.load(column)));
      const missing = columns.filter((_, index) => rows[index] === null);
      if (missing.length > 0) {
        throw new GraphQLError(
          `No metadata row for column(s): ${missing.join(', ')}. ` +
            `Every fact_table column must be declared in the metadata table.`,
          { extensions: { code: 'INTERNAL_SERVER_ERROR' } },
        );
      }

      const fields = rows as FieldMetadata[];
      return scope ? attachScopeToAll(fields, scope) : fields;
    },
  },
};

export { factResolvers };
