// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { enrichFactsWithDimensions } from '../../utils/dimension-enrichment.js';
import { config } from '../../utils/config-loader.js';
import { GraphQLError } from 'graphql';
import type { GraphQLContext } from './types.js';
import type { FactQueryParams } from '../../loaders/fact.js';

// ─── Interfaces des arguments ─────────────────────────────────────────────────

/** Common arguments for fact table queries, including catalog/schema routing. */
export interface FactTableArgs extends FactQueryParams {
  catalog?: string | null;
  schema?: string | null;
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

// Construction de resolvers pour la table des données
/**
 * Resolvers for fact table queries.
 *
 * Handles the retrieval and formatting of fact data from the database,
 * including optional dimension enrichment and D3-compatible output formats.
 */
const factResolvers = {
  Query: {
    /**
     * Fetches a paginated page of fact rows with dimension enrichment.
     *
     * Validates the pagination parameters against configured limits before
     * issuing the DataLoader call, then enriches every returned row with
     * its categorical dimension labels in a single bulk pass.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param args - Fact query parameters including limit, offset and database.
     * @param context - GraphQL context with loaders.
     * @returns Paginated result object with enriched fact rows.
     * @throws {GraphQLError} When limit or offset exceed configured maximums.
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
      const factLoader = targetLoaders ? targetLoaders.factWithCount : loaders.factWithCount;
      const enrichmentLoaders = targetLoaders ?? loaders;

      const result = (await withTimeout(
        factLoader.load(args),
        config.API.TIMEOUTS.FACT_SIMPLE,
        'Fact table fetch timeout',
      )) as PaginatedFactResult;

      // Enrichissement en masse des dimensions pour toutes les lignes
      if (result && result.data) {
        const enrichedData = await withTimeout(
          enrichFactsWithDimensions(result.data, enrichmentLoaders),
          config.API.TIMEOUTS.FACT_COMPLEX,
          'Dimension enrichment timeout',
        );

        return { ...result, data: enrichedData };
      }

      return result;
    },

    /**
     * Fetches fact rows with D3-compatible metadata and dimension enrichment.
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
    getFactTableWithMetadata: async (
      _: unknown,
      args: FactTableArgs,
      { loaders, getLoadersForCatalog }: GraphQLContext,
    ) => {
      // Sélection des loaders adaptés au catalogue/schéma cible
      const targetLoaders = getLoadersForCatalog(args.catalog, args.schema);
      const activeLoaders = targetLoaders ?? loaders;

      const result = (await withTimeout(
        activeLoaders.factWithMetadata.load(args),
        config.API.TIMEOUTS.FACT_SIMPLE,
        'Metadata fact table fetch timeout',
      )) as PaginatedFactResult;

      // Enrichissement en masse des dimensions pour toutes les lignes
      if (result && result.data) {
        const enrichedData = await withTimeout(
          enrichFactsWithDimensions(result.data, activeLoaders),
          config.API.TIMEOUTS.FACT_COMPLEX,
          'Dimension enrichment timeout',
        );

        // Format ARRAYS : transformation de [{col: val}] en [[val1, val2, ...]]
        // Les colonnes sont déjà présentes dans result.columns
        if (args.format === 'ARRAYS' && result.columns) {
          return {
            ...result,
            data: enrichedData.map((row) =>
              result.columns!.map((col) => (row as Record<string, unknown>)[col] ?? null),
            ),
          };
        }

        return { ...result, data: enrichedData };
      }

      return result;
    },
  },
};

export { factResolvers };
