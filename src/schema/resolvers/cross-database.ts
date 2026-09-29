// Importation des modules
import { GraphQLError } from 'graphql';
import { withTimeout } from '../../utils/timeout.js';
import { databaseManager } from '../../db/index.js';
import { config } from '../../utils/config-loader.js';
import { assertColumns } from '../../utils/identifiers.js';
import { indexMetadataByName, resolveLabelField } from '../../utils/metadata-mapping.js';
import { validatePagination } from '../../utils/pagination.js';
import { AGGREGATIONS } from '../../utils/aggregations.js';
import type { FieldMetadata } from '../../utils/metadata-mapping.js';
import type { GraphQLContext } from './types.js';
import type { LoadersCollection } from '../../loaders/index.js';
import type { Aggregation } from '../../generated/graphql.js';
import type {
  CompareFactsParams,
  CompareAggregatedFactsParams,
  CrossDatabaseSelectOptionsParams,
} from '../../loaders/cross-database.js';

// ─── Interfaces des arguments ─────────────────────────────────────────────────

/** Arguments for the compareFacts query. */
export interface CompareFactsArgs {
  catalogA: string;
  catalogB: string;
  schemaA?: string | null;
  schemaB?: string | null;
  joinFields: string[];
  limit?: number;
  offset?: number;
  sort?: Array<{ field: string; order: 'ASC' | 'DESC' }>;
}

/** Arguments for the compareAggregatedFacts query. */
export interface CompareAggregatedFactsArgs {
  catalogA: string;
  catalogB: string;
  schemaA?: string | null;
  schemaB?: string | null;
  groupBy: string;
  aggregation?: Aggregation;
  limit?: number;
  offset?: number;
}

/** Arguments for the crossDatabaseSelectOptions query. */
export interface CrossDatabaseSelectOptionsArgs {
  fieldName: string;
  catalogs: string[];
  schemas?: (string | null)[];
  limit?: number;
}

// ─── Fonction utilitaire ──────────────────────────────────────────────────────

/**
 * Checks that cross-catalog queries are enabled and throws if not.
 *
 * @throws {GraphQLError} When cross-catalog queries are disabled.
 */
// Vérification de l'activation des requêtes cross-catalog
function assertCrossDatabaseAllowed(): void {
  if (!databaseManager.isCrossCatalogAllowed()) {
    throw new GraphQLError(
      'Cross-catalog queries are disabled. Set ALLOW_CROSS_CATALOG_QUERIES=true to enable them.',
      { extensions: { code: 'CROSS_DATABASE_DISABLED' } },
    );
  }
}

/**
 * Validates a catalog alias and throws a descriptive error when invalid.
 *
 * @param catalog - Catalog alias to validate.
 * @throws {GraphQLError} When the alias is not registered in the database manager.
 */
// Validation d'un identifiant de catalogue
function assertValidCatalog(catalog: string): void {
  if (!databaseManager.isValidCatalog(catalog)) {
    throw new GraphQLError(`Catalog '${catalog}' is not available.`, {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
}

// Colonnes projetées par compareFacts, seules cibles possibles de son tri
const COMPARISON_SORT_FIELDS = ['key', 'keyLabel', 'valueA', 'valueB', 'delta', 'deltaPercent'];

/**
 * Loads the metadata of one side of a cross-dataset query.
 *
 * Reads the side's metadata through the catalogMetadata loader (same cache as
 * getCatalogSchema). The schema is checked against the catalog's allow-list
 * first: the metadata loader interpolates it into SQL.
 *
 * @param loaders - Request loaders (catalogMetadata is catalog-independent).
 * @param catalog - Catalog alias of the side, already validated.
 * @param schema - Schema of the side; null uses the catalog default.
 * @returns The side's metadata rows keyed by column name.
 * @throws {GraphQLError} When the schema is not available for the catalog.
 */
// Métadonnées d'un côté de la requête cross-dataset
async function loadSideMetadata(
  loaders: LoadersCollection,
  catalog: string,
  schema: string | null,
): Promise<Map<string, FieldMetadata>> {
  if (schema && !databaseManager.isValidSchema(catalog, schema)) {
    throw new GraphQLError(
      `Schema '${schema}' is not available for catalog '${catalog}'. ` +
        `Available: ${databaseManager.getSchemas(catalog).join(', ')}`,
    );
  }
  const rows = await loaders.catalogMetadata.load({ catalog, schema });
  return indexMetadataByName(rows);
}

/**
 * Checks columns against one side's metadata and returns the label column of
 * the key field on that side.
 *
 * Every column interpolated in the SQL of a comparison must exist on BOTH
 * sides: the check runs once per side, naming it in the message.
 *
 * @param loaders - Request loaders.
 * @param catalog - Catalog alias of the side, already validated.
 * @param schema - Schema of the side; null uses the catalog default.
 * @param columns - Columns the query interpolates for this side.
 * @param role - Role of the columns, quoted in the message (e.g. 'joinField').
 * @param keyField - Field whose label column is looked up, or null for none.
 * @returns The effective label column of keyField, or null.
 * @throws {GraphQLError} BAD_USER_INPUT when a column is unknown on this side.
 */
// Contrôle des colonnes d'un côté, puis colonne de libellés de la clé
async function checkSide(
  loaders: LoadersCollection,
  catalog: string,
  schema: string | null,
  columns: string[],
  role: string,
  keyField: string | null,
): Promise<string | null> {
  const byName = await loadSideMetadata(loaders, catalog, schema);
  const side = `${catalog}.${schema ?? databaseManager.getDefaultSchema(catalog)}`;
  assertColumns(columns, byName, `${role} (${side})`);
  return keyField ? resolveLabelField(keyField, byName) : null;
}

// Resolver pour les requêtes cross-catalog
/**
 * Resolvers for cross-catalog / cross-schema query operations.
 *
 * All resolvers check that cross-catalog queries are enabled and that each
 * provided catalog alias is valid before dispatching to the loader. Comparing
 * two schemas of the same catalog (catalogA === catalogB, distinct schemas) is
 * supported and gated by the same flag. The label columns that fill
 * `ComparedFact.keyLabel` are resolved here, before the load, so that they
 * are part of the cache key.
 */
const crossDatabaseResolvers = {
  Query: {
    /**
     * Compares fact rows across two datasets joined on common fields.
     * Arguments follow {@link CompareFactsArgs}.
     *
     * @param _ - Parent resolver result (unused at root).
     * @returns Comparison result with rows from both datasets.
     * @throws {GraphQLError} When cross-catalog is disabled, catalogs are
     *     invalid, joinFields is empty, or limit exceeds the maximum.
     */
    // Comparaison des faits entre deux datasets
    compareFacts: async (
      _: unknown,
      {
        catalogA,
        catalogB,
        schemaA = null,
        schemaB = null,
        joinFields,
        limit = config.API.PAGINATION.DEFAULT_LIMIT,
        offset = 0,
        sort = [],
      }: CompareFactsArgs,
      { loaders }: GraphQLContext,
    ) => {
      // Vérification de l'activation des requêtes cross-catalog
      assertCrossDatabaseAllowed();

      // Validation des identifiants de catalogues
      [catalogA, catalogB].forEach(assertValidCatalog);

      // Vérification de la présence des champs de jointure
      if (!joinFields || joinFields.length === 0) {
        throw new GraphQLError('At least one joinField is required', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      // Validation de la pagination
      validatePagination(limit, offset);

      // Tri limité aux colonnes projetées par la comparaison
      const badSort = sort.filter(({ field }) => !COMPARISON_SORT_FIELDS.includes(field));
      if (badSort.length > 0) {
        throw new GraphQLError(
          `Invalid sort field(s): ${badSort.map(({ field }) => `"${field}"`).join(', ')}. ` +
            `Allowed: ${COMPARISON_SORT_FIELDS.join(', ')}.`,
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }

      // Champs de jointure contrôlés des deux côtés ; libellé de la clé
      // seulement pour un champ de jointure unique
      const keyField = joinFields.length === 1 ? joinFields[0] : null;
      const [labelFieldA, labelFieldB] = await Promise.all([
        checkSide(loaders, catalogA, schemaA, joinFields, 'joinField', keyField),
        checkSide(loaders, catalogB, schemaB, joinFields, 'joinField', keyField),
      ]);

      return withTimeout(
        loaders.compareFacts.load({
          catalogA,
          catalogB,
          schemaA,
          schemaB,
          joinFields,
          labelFieldA,
          labelFieldB,
          limit,
          offset,
          sort,
        } as CompareFactsParams),
        config.API.TIMEOUTS.FACT_COMPLEX,
        'compareFacts timeout',
      );
    },

    /**
     * Compares aggregated facts across two datasets grouped by a column.
     * Arguments follow {@link CompareAggregatedFactsArgs}.
     *
     * @param _ - Parent resolver result (unused at root).
     * @returns Comparison result with aggregated rows from both datasets.
     * @throws {GraphQLError} When cross-catalog is disabled, catalogs or
     *     aggregation type are invalid, or groupBy is missing.
     */
    // Comparaison des faits agrégés entre deux datasets
    compareAggregatedFacts: async (
      _: unknown,
      {
        catalogA,
        catalogB,
        schemaA = null,
        schemaB = null,
        groupBy,
        aggregation = 'SUM',
        limit = config.API.PAGINATION.DEFAULT_LIMIT,
        offset = 0,
      }: CompareAggregatedFactsArgs,
      { loaders }: GraphQLContext,
    ) => {
      // Vérification de l'activation des requêtes cross-catalog
      assertCrossDatabaseAllowed();

      // Validation des identifiants de catalogues
      [catalogA, catalogB].forEach(assertValidCatalog);

      // Vérification de la présence du champ de regroupement
      if (!groupBy) {
        throw new GraphQLError('groupBy is required', { extensions: { code: 'BAD_USER_INPUT' } });
      }

      // Validation de la pagination
      validatePagination(limit, offset);

      // Validation du type d'agrégation
      if (!AGGREGATIONS.includes(aggregation)) {
        throw new GraphQLError(`Invalid aggregation. Must be one of: ${AGGREGATIONS.join(', ')}`, {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      // groupBy contrôlé des deux côtés ; libellé de la clé de groupe de chaque
      // côté, même règle que getAggregatedFacts
      const [labelFieldA, labelFieldB] = await Promise.all([
        checkSide(loaders, catalogA, schemaA, [groupBy], 'groupBy', groupBy),
        checkSide(loaders, catalogB, schemaB, [groupBy], 'groupBy', groupBy),
      ]);

      return withTimeout(
        loaders.compareAggregatedFacts.load({
          catalogA,
          catalogB,
          schemaA,
          schemaB,
          groupBy,
          labelFieldA,
          labelFieldB,
          aggregation,
          limit,
          offset,
        } as CompareAggregatedFactsParams),
        config.API.TIMEOUTS.AGGREGATED_SIMPLE,
        'compareAggregatedFacts timeout',
      );
    },

    /**
     * Fetches select options for a field across multiple datasets.
     * Arguments follow {@link CrossDatabaseSelectOptionsArgs}.
     *
     * @param _ - Parent resolver result (unused at root).
     * @returns Merged list of select options from all datasets.
     * @throws {GraphQLError} When cross-catalog is disabled, fewer than two
     *     catalogs are specified, or any alias is invalid.
     */
    // Récupération des options de sélection sur plusieurs datasets
    crossDatabaseSelectOptions: async (
      _: unknown,
      { fieldName, catalogs, schemas, limit = 50 }: CrossDatabaseSelectOptionsArgs,
      { loaders }: GraphQLContext,
    ) => {
      // Vérification de l'activation des requêtes cross-catalog
      assertCrossDatabaseAllowed();

      // Vérification de la présence d'au moins deux catalogues
      if (!catalogs || catalogs.length < 2) {
        throw new GraphQLError('At least two catalogs must be specified', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      // Validation de chaque identifiant de catalogue
      catalogs.forEach(assertValidCatalog);

      // Validation de la limite
      validatePagination(limit);

      // Champ contrôlé contre les métadonnées de chaque cible
      await Promise.all(
        catalogs.map((catalog, i) =>
          checkSide(loaders, catalog, schemas?.[i] ?? null, [fieldName], 'fieldName', null),
        ),
      );

      return withTimeout(
        loaders.crossDatabaseSelectOptions.load({
          fieldName,
          catalogs,
          schemas: schemas ?? undefined,
          limit,
        } as CrossDatabaseSelectOptionsParams),
        config.API.TIMEOUTS.FACT_SIMPLE,
        'crossDatabaseSelectOptions timeout',
      );
    },
  },
};

export { crossDatabaseResolvers };
