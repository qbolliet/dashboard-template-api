// Importation des modules
import { withTimeout } from '../../utils/timeout.js';
import { GraphQLError } from 'graphql';
import { config } from '../../utils/config-loader.js';
import { compileFilterTree, sqlTypeFamily } from '../../utils/filter-tree.js';
import { assertColumns } from '../../utils/identifiers.js';
import { indexMetadataByName, resolveLabelField } from '../../utils/metadata-mapping.js';
import { validatePagination } from '../../utils/pagination.js';
import { attachScope, contextScope } from './scope.js';
import type { GraphQLContext } from './types.js';
import type { FieldMetadata } from '../../utils/metadata-mapping.js';
import type { LoadersCollection } from '../../loaders/index.js';
import type { AggregatedQueryParams } from '../../loaders/aggregated-facts.js';
import type { FilterNodeInput } from '../../utils/filter-tree.js';

// ─── Types d'agrégation ───────────────────────────────────────────────────────

/** Supported SQL aggregation operations. */
export type AggregationType = 'SUM' | 'AVG' | 'MAX' | 'MIN' | 'COUNT' | 'MEDIAN' | 'MODE';

/** Valid values for sort order. */
export type SortOrder = 'ASC' | 'DESC';

/** Sort criterion specific to aggregated fact queries. */
export interface AggregatedSortItem {
  field: 'key' | 'aggregatedValue';
  order: SortOrder;
}

// ─── Interfaces des arguments ─────────────────────────────────────────────────

/** Common arguments for the getAggregatedFacts and getAggregatedFactsWithMetadata queries. */
export interface AggregatedFactsArgs {
  fields?: string[];
  structuredFilters?: FilterNodeInput | null;
  groupBy: string;
  measure: string;
  /** Absente, l'agrégation vient de metadata.defaultAggregation puis de SUM. */
  aggregation?: AggregationType | null;
  limit?: number;
  offset?: number;
  sort?: AggregatedSortItem[];
  catalog?: string | null;
  schema?: string | null;
}

// ─── Interfaces des résultats ─────────────────────────────────────────────────

/** One aggregated row: a group-by key and its aggregated value. */
export interface AggregatedFactRow {
  key: unknown;
  [key: string]: unknown;
}

/** Aggregated result with metadata, used by getAggregatedFactsWithMetadata. */
export interface AggregatedWithMetadataResult {
  data: AggregatedFactRow[];
  metadata: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── Constantes de validation ─────────────────────────────────────────────────

/** Exhaustive list of supported aggregation operations. */
const VALID_AGGREGATIONS: readonly AggregationType[] = [
  'SUM',
  'AVG',
  'MAX',
  'MIN',
  'COUNT',
  'MEDIAN',
  'MODE',
];

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

// Agrégations qui exigent une mesure numérique (ou booléenne, sommée comme 0/1)
const NUMERIC_AGGREGATIONS: readonly AggregationType[] = ['SUM', 'AVG'];

/**
 * Builds a GraphQL error flagged as a client input error.
 *
 * @param message - Human-readable error message.
 * @returns GraphQLError with the BAD_USER_INPUT extension code.
 */
const badInput = (message: string): GraphQLError =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

/**
 * Validates the aggregation and sort arguments for aggregated fact queries.
 *
 * Centralises argument validation to avoid duplication between the two
 * aggregated fact resolvers. Pagination is validated before, by
 * validatePagination, and the columns by validateAggregatedColumns.
 *
 * @param aggregation - Aggregation type to validate.
 * @param groupBy - Group-by field (must be non-empty).
 * @param measure - Measure column to aggregate (must be non-empty).
 * @param sort - Sort items to validate (field and order).
 * @throws {GraphQLError} BAD_USER_INPUT when any argument fails validation.
 */
// Validation centralisée des arguments des requêtes agrégées
function validateAggregatedArgs(
  aggregation: AggregationType,
  groupBy: string | undefined,
  measure: string | undefined,
  sort: AggregatedSortItem[],
): void {
  // Validation des opérations d'agrégation
  if (!VALID_AGGREGATIONS.includes(aggregation)) {
    throw badInput(`Invalid aggregation type. Must be one of: ${VALID_AGGREGATIONS.join(', ')}`);
  }

  // Groupby est un élément obligatoire
  if (!groupBy) {
    throw badInput('groupBy field is required');
  }

  // La mesure à agréger est obligatoire
  if (!measure) {
    throw badInput('measure field is required');
  }

  // Validation des champs sur lesquels trier et des opérations de tri
  sort.forEach(({ field, order }) => {
    if (field !== 'key' && field !== 'aggregatedValue') {
      throw badInput('Sort field must be either "key" or "aggregatedValue"');
    }
    if (!['ASC', 'DESC'].includes(order)) {
      throw badInput('Sort order must be either "ASC" or "DESC"');
    }
  });
}

/**
 * Checks groupBy and measure against the metadata table, and the aggregation
 * against the type of the measure.
 *
 * Both columns are interpolated (quoted) in the SQL, so an unknown one must
 * be a client error rather than a DuckDB binder error. SUM and AVG require a
 * numeric (or boolean) measure; other type mismatches are reported by DuckDB
 * and mapped to BAD_USER_INPUT by the loader.
 *
 * @param groupBy - Group-by column.
 * @param measure - Measure column.
 * @param aggregation - Effective aggregation.
 * @param activeLoaders - Loaders bound to the target catalog/schema.
 * @throws {GraphQLError} BAD_USER_INPUT on an unknown column or an
 *   aggregation incompatible with the measure type.
 */
// Colonnes contrôlées contre metadata, agrégation contre le type de la mesure
async function validateAggregatedColumns(
  groupBy: string,
  measure: string,
  aggregation: AggregationType,
  activeLoaders: LoadersCollection,
): Promise<void> {
  const rows = await activeLoaders.metadata.loadMany([groupBy, measure]);
  const failure = rows.find((row): row is Error => row instanceof Error);
  if (failure) throw failure;
  const byName = indexMetadataByName(rows as (FieldMetadata | null)[]);
  assertColumns([groupBy], byName, 'groupBy');
  assertColumns([measure], byName, 'measure');

  if (NUMERIC_AGGREGATIONS.includes(aggregation)) {
    const sqlType = byName.get(measure)?.sqlType ?? '';
    let family: string;
    try {
      family = sqlTypeFamily(sqlType);
    } catch {
      family = 'unsupported';
    }
    if (family !== 'numeric' && family !== 'boolean') {
      throw badInput(
        `Aggregation ${aggregation} requires a numeric measure; "${measure}" is ${sqlType || 'untyped'}.`,
      );
    }
  }
}

/**
 * Resolves the aggregation actually applied to a measure.
 *
 * The argument wins when the client supplies one; otherwise the measure's
 * `defaultAggregation` metadata applies, and SUM closes the chain. The
 * resolution happens here rather than in the loader on purpose: the effective
 * value is then part of the loader parameters, hence part of the cache key —
 * two requests differing only by their implicit aggregation must not share a
 * cache entry.
 *
 * @param explicit - Aggregation passed by the client, if any.
 * @param measure - Measure column being aggregated.
 * @param activeLoaders - Loaders bound to the target catalog/schema.
 * @returns The aggregation to apply.
 */
// Agrégation effective : argument, puis defaultAggregation de la mesure, puis SUM
async function resolveAggregation(
  explicit: AggregationType | null | undefined,
  measure: string | undefined,
  activeLoaders: LoadersCollection,
): Promise<AggregationType> {
  if (explicit) return explicit;
  if (!measure) return 'SUM';

  const meta = await activeLoaders.metadata.load(measure);
  const declared = meta?.defaultAggregation;
  if (declared && VALID_AGGREGATIONS.includes(declared as AggregationType)) {
    return declared as AggregationType;
  }
  return 'SUM';
}

/**
 * Resolves the label column whose value fills `keyLabel`.
 *
 * Same default rule as the select options (resolveLabelField, no argument):
 * the effective column is part of the loader parameters, hence of the cache
 * key, and the loader reads the label in the aggregation query itself.
 *
 * @param groupBy - Group-by column.
 * @param activeLoaders - Loaders bound to the target catalog/schema.
 * @returns The label column of groupBy, or null when it has none.
 */
// Colonne de libellés de la clé de groupe, règle par défaut
async function resolveKeyLabelField(
  groupBy: string,
  activeLoaders: LoadersCollection,
): Promise<string | null> {
  const meta = await activeLoaders.metadata.load(groupBy);
  return meta ? resolveLabelField(groupBy, indexMetadataByName([meta])) : null;
}

// Resolver pour les données agrégées
/**
 * Resolvers for aggregated fact queries.
 *
 * Supports flexible grouping, multiple aggregation functions, sorting,
 * pagination, and optional D3 metadata. The group-by column of the fact
 * table already holds its label; a code column with a label column also
 * returns that label as `keyLabel`, read by the same SQL query.
 */
const aggregatedFactsResolvers = {
  Query: {
    /**
     * Fetches aggregated facts grouped by a fact table column.
     *
     * Validates all arguments, then loads the aggregated data via DataLoader.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param args - Aggregation query parameters.
     * @param context - GraphQL context with loaders.
     * @returns Array of enriched aggregated fact rows.
     * @throws {GraphQLError} When validation fails or the loader times out.
     */
    getAggregatedFacts: async (
      _: unknown,
      {
        fields,
        structuredFilters,
        groupBy,
        measure,
        aggregation,
        limit = config.API.PAGINATION.DEFAULT_LIMIT,
        offset = 0,
        sort = [],
        catalog,
        schema,
      }: AggregatedFactsArgs,
      { loaders, getLoadersForCatalog }: GraphQLContext,
    ) => {
      // Pagination validée avant tout accès à la base
      validatePagination(limit, offset);

      const targetLoaders = getLoadersForCatalog(catalog, schema);
      const activeLoaders = targetLoaders ?? loaders;

      // Agrégation effective, résolue avant validation et avant la clé de cache
      const effectiveAggregation = await resolveAggregation(aggregation, measure, activeLoaders);

      // Validation centralisée des paramètres de la requête
      validateAggregatedArgs(effectiveAggregation, groupBy, measure, sort);
      await validateAggregatedColumns(groupBy, measure, effectiveAggregation, activeLoaders);

      try {
        // Compilation de l'arbre de filtres avec les métadonnées du dataset cible
        const where = await compileFilterTree(structuredFilters, (names) =>
          activeLoaders.metadata.loadMany(names),
        );
        // Colonne de libellés de la clé, lue par ANY_VALUE dans la même requête
        const labelField = await resolveKeyLabelField(groupBy, activeLoaders);

        const results = (await withTimeout(
          activeLoaders.aggregatedFacts.load({
            fields,
            where,
            groupBy,
            measure,
            aggregation: effectiveAggregation,
            labelField,
            limit,
            offset,
            sort,
          } as AggregatedQueryParams),
          config.API.TIMEOUTS.AGGREGATED_SIMPLE,
          'Aggregated facts fetch timeout',
        )) as unknown as AggregatedFactRow[];

        // Libellé de la clé déjà lu par la requête : aucune résolution supplémentaire
        return results;
      } catch (error) {
        // Les erreurs de validation (BAD_USER_INPUT) remontent telles quelles au client
        if (error instanceof GraphQLError) throw error;
        if ((error as Error).message === 'Aggregated facts fetch timeout') {
          throw error;
        }
        throw new Error('Failed to fetch aggregated facts', { cause: error });
      }
    },

    /**
     * Fetches aggregated facts with D3-compatible metadata.
     *
     * Applies the same validation and enrichment as getAggregatedFacts,
     * but also returns axis extents and statistics for chart configuration.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param args - Aggregation query parameters.
     * @param context - GraphQL context with loaders.
     * @returns Object with enriched data array and D3 metadata.
     * @throws {GraphQLError} When validation fails or the loader times out.
     */
    getAggregatedFactsWithMetadata: async (
      _: unknown,
      {
        fields,
        structuredFilters,
        groupBy,
        measure,
        aggregation,
        limit = config.API.PAGINATION.DEFAULT_LIMIT,
        offset = 0,
        sort = [],
        catalog,
        schema,
      }: AggregatedFactsArgs,
      context: GraphQLContext,
    ) => {
      // Pagination validée avant tout accès à la base
      validatePagination(limit, offset);

      // Instanciation des loaders
      const targetLoaders = context.getLoadersForCatalog(catalog, schema);
      const activeLoaders = targetLoaders ?? context.loaders;

      // Agrégation effective, résolue avant validation et avant la clé de cache
      const effectiveAggregation = await resolveAggregation(aggregation, measure, activeLoaders);

      // Validation centralisée des paramètres de la requête
      validateAggregatedArgs(effectiveAggregation, groupBy, measure, sort);
      await validateAggregatedColumns(groupBy, measure, effectiveAggregation, activeLoaders);

      try {
        // Compilation de l'arbre de filtres avec les métadonnées du dataset cible
        const where = await compileFilterTree(structuredFilters, (names) =>
          activeLoaders.metadata.loadMany(names),
        );
        // Colonne de libellés de la clé, lue par ANY_VALUE dans la même requête
        const labelField = await resolveKeyLabelField(groupBy, activeLoaders);

        const result = (await withTimeout(
          activeLoaders.aggregatedFactsWithMetadata.load({
            fields,
            where,
            groupBy,
            measure,
            aggregation: effectiveAggregation,
            labelField,
            limit,
            offset,
            sort,
          } as AggregatedQueryParams),
          config.API.TIMEOUTS.AGGREGATED_SIMPLE,
          'Aggregated facts with metadata fetch timeout',
        )) as unknown as AggregatedWithMetadataResult;

        // Métadonnées de la mesure : loader de métadonnées (mis en cache), sans requête de plus
        const measureFieldInfo = await activeLoaders.metadata.load(measure);

        // Catalogue et schéma rattachés aux deux Metadata pour la résolution paresseuse de `stats`
        const scope = contextScope(context, catalog, schema);
        const groupByFieldInfo = attachScope(
          result.metadata.groupByFieldInfo as FieldMetadata | null,
          scope,
        );

        // Libellé de la clé déjà lu par la requête : aucune résolution supplémentaire
        return {
          ...result,
          metadata: {
            ...result.metadata,
            groupByFieldInfo,
            measureFieldInfo: attachScope(measureFieldInfo, scope),
          },
        };
      } catch (error) {
        // Les erreurs de validation (BAD_USER_INPUT) remontent telles quelles au client
        if (error instanceof GraphQLError) throw error;
        if ((error as Error).message === 'Aggregated facts fetch timeout') {
          throw error;
        }
        throw new Error('Failed to fetch aggregated facts', { cause: error });
      }
    },
  },
};

export { aggregatedFactsResolvers };
