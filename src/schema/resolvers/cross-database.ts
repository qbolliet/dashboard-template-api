// Importation des modules
import { GraphQLError } from 'graphql';
import { previewValue } from '../../utils/preview-value.js';
import { withTimeout } from '../../utils/timeout.js';
import { databaseManager } from '../../db/index.js';
import { config } from '../../utils/config-loader.js';
import { assertColumns } from '../../utils/identifiers.js';
import { indexMetadataByName, resolveLabelField } from '../../utils/metadata-mapping.js';
import { validatePagination } from '../../utils/pagination.js';
import { allowedAggregations } from '../../utils/aggregations.js';
import {
  aggregateDisplayFormat,
  aggregateUnit,
  assertNumericAggregate,
  badInput,
  effectiveAggregation,
  labelColumnOf,
  resolveAggregateParams,
} from '../../utils/aggregate-query.js';
import { comparedColumnsOf } from '../../loaders/cross-database.js';
import { attachScope, effectiveScope } from './scope.js';
import type { FieldMetadata } from '../../utils/metadata-mapping.js';
import type { ResolvedAggregateParams, ResolvedSort } from '../../utils/aggregate-query.js';
import type { ColumnExtent } from '../../db/json-conversion.js';
import type { LoadersCollection } from '../../loaders/index.js';
import type { AggregateSortInput, Aggregation, QueryResolvers } from '../../generated/graphql.js';
import type {
  CompareFactsParams,
  CompareAggregatedFactsParams,
  CrossDatabaseSelectOptionsParams,
} from '../../loaders/cross-database.js';

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

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
    throw new GraphQLError(`Catalog ${previewValue(catalog)} is not available.`, {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
}

// Colonnes projetées par compareFacts, seules cibles possibles de son tri
const COMPARISON_SORT_FIELDS = ['key', 'keyLabel', 'valueA', 'valueB', 'delta', 'deltaPercent'];

// Mesure comparée par défaut par compareFacts
const DEFAULT_MEASURE = 'value';

/** Metadata of one side of a cross-dataset query. */
interface SideMetadata {
  /** Metadata rows keyed by column name, `labelFields` filled. */
  byName: Map<string, FieldMetadata>;
  /** `<catalog>.<schema>`, quoted in the error messages. */
  name: string;
}

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
 * @returns The side's metadata rows keyed by column name, and its name.
 * @throws {GraphQLError} When the schema is not available for the catalog.
 */
// Métadonnées d'un côté de la requête cross-dataset
async function loadSideMetadata(
  loaders: LoadersCollection,
  catalog: string,
  schema: string | null,
): Promise<SideMetadata> {
  if (schema && !databaseManager.isValidSchema(catalog, schema)) {
    throw new GraphQLError(
      `Schema ${previewValue(schema)} is not available for catalog ${previewValue(catalog)}. ` +
        `Available: ${databaseManager.getSchemas(catalog).join(', ')}`,
    );
  }
  const rows = await loaders.catalogMetadata.load({ catalog, schema });
  return {
    byName: indexMetadataByName(rows),
    name: `${catalog}.${schema ?? databaseManager.getDefaultSchema(catalog)}`,
  };
}

/**
 * Resolves the aggregation of a compared measure on one side and checks it.
 *
 * @param explicit - Aggregation passed by the client, if any.
 * @param measure - Metadata of the measure on this side.
 * @returns The effective aggregation (argument, defaultAggregation, then SUM).
 * @throws {GraphQLError} BAD_USER_INPUT when it is not allowed on the measure
 *   or does not yield a number.
 */
// Agrégation effective d'une mesure comparée, contrôlée sur un côté
function comparedAggregation(
  explicit: Aggregation | null | undefined,
  measure: FieldMetadata,
): Aggregation {
  const aggregation = effectiveAggregation(explicit, measure);
  const allowed = allowedAggregations(measure.sqlType);
  if (!allowed.includes(aggregation)) {
    throw badInput(
      `Aggregation ${aggregation} is not allowed on measure ${previewValue(measure.name)} ` +
        `(${measure.sqlType || 'untyped'}). Allowed aggregations: ${allowed.join(', ')}.`,
    );
  }
  assertNumericAggregate(aggregation, measure);
  return aggregation;
}

/**
 * Checks that both sides aggregate a measure the same way.
 *
 * Without an explicit aggregation, each side applies the defaultAggregation of
 * its own metadata, which may differ: the comparison would then set a sum
 * against a mean.
 *
 * @param measure - Compared measure.
 * @param aggregationA - Effective aggregation on side A.
 * @param aggregationB - Effective aggregation on side B.
 * @throws {GraphQLError} BAD_USER_INPUT when they differ.
 */
// Même agrégation exigée des deux côtés
function assertSameAggregation(
  measure: string,
  aggregationA: Aggregation,
  aggregationB: Aggregation,
): void {
  if (aggregationA !== aggregationB) {
    throw badInput(
      `Measure ${previewValue(measure)} aggregates as ${aggregationA} in dataset A and as ` +
        `${aggregationB} in dataset B (defaultAggregation); pass aggregation explicitly.`,
    );
  }
}

/**
 * Resolves the sort of an aggregate comparison on its output columns.
 *
 * Same rule as getAggregates: each criterion must name an output column, the
 * first occurrence of a column wins, and every group column is appended
 * (ascending) as a tie-break, so that the order is total.
 *
 * @param sort - Client sort, if any.
 * @param outputColumns - Columns of the comparison rows.
 * @param groupFields - Group columns.
 * @returns The resolved sort.
 * @throws {GraphQLError} BAD_USER_INPUT on an unknown column.
 */
// Tri sur les colonnes de sortie, départagé par toutes les colonnes de groupe
function resolveComparisonSort(
  sort: readonly AggregateSortInput[] | null | undefined,
  outputColumns: readonly string[],
  groupFields: readonly string[],
): ResolvedSort[] {
  const resolved: ResolvedSort[] = [];
  for (const { by, order } of sort ?? []) {
    if (!outputColumns.includes(by)) {
      throw badInput(
        `Unknown sort column ${previewValue(by)}. Sortable columns: ${outputColumns.join(', ')}.`,
      );
    }
    if (!resolved.some((item) => item.by === by)) resolved.push({ by, order: order ?? 'ASC' });
  }
  for (const field of groupFields) {
    if (!resolved.some((item) => item.by === field)) resolved.push({ by: field, order: 'ASC' });
  }
  return resolved;
}

/**
 * Merges the extents of the two sides of a compared aggregate.
 *
 * @param extentA - Extent of `<alias>_a` on the page, if any.
 * @param extentB - Extent of `<alias>_b` on the page, if any.
 * @returns [min, max] over both columns, or the one available, or null.
 */
// Étendue commune des deux côtés d'un agrégat comparé (axe partagé)
function mergeExtents(
  extentA: ColumnExtent | undefined,
  extentB: ColumnExtent | undefined,
): ColumnExtent | null {
  if (!extentA || !extentB) return extentA ?? extentB ?? null;
  // Agrégats comparés toujours numériques : étendues numériques
  const [minA, maxA] = extentA as [number, number];
  const [minB, maxB] = extentB as [number, number];
  return [Math.min(minA, minB), Math.max(maxA, maxB)];
}

// Resolver pour les requêtes cross-catalog
/**
 * Resolvers for cross-catalog / cross-schema query operations.
 *
 * All resolvers check that cross-catalog queries are enabled and that each
 * provided catalog alias is valid before dispatching to the loader. Comparing
 * two schemas of the same catalog (catalogA === catalogB, distinct schemas) is
 * supported and gated by the same flag. Every column, aggregation and label
 * column is resolved here against the metadata of BOTH sides, before the load,
 * so that the resolved values are part of the cache key.
 */
const crossDatabaseResolvers: {
  Query: Pick<
    QueryResolvers,
    'compareFacts' | 'compareAggregatedFacts' | 'crossDatabaseSelectOptions'
  >;
} = {
  Query: {
    /**
     * Compares a measure across two datasets, one row per join key.
     * Arguments follow the generated `QueryCompareFactsArgs`.
     *
     * @param _ - Parent resolver result (unused at root).
     * @returns Comparison result, one row per key common to both datasets.
     * @throws {GraphQLError} When cross-catalog is disabled, catalogs are
     *     invalid, joinFields is empty, a column is unknown on a side, the
     *     measure cannot be compared, or the page is out of bounds.
     */
    // Comparaison d'une mesure entre deux datasets
    compareFacts: async (
      _,
      {
        catalogA,
        catalogB,
        schemaA,
        schemaB,
        joinFields,
        measure,
        aggregation,
        limit,
        offset,
        sort,
      },
      { loaders },
    ) => {
      // Vérification de l'activation des requêtes cross-catalog
      assertCrossDatabaseAllowed();

      // Validation des identifiants de catalogues
      [catalogA, catalogB].forEach(assertValidCatalog);

      // Vérification de la présence des champs de jointure
      if (!joinFields || joinFields.length === 0) {
        throw badInput('At least one joinField is required');
      }

      // Validation de la pagination
      validatePagination(limit, offset);

      // Tri limité aux colonnes projetées par la comparaison
      const sortItems = (sort ?? []).map(({ field, order }) => ({ field, order: order ?? 'ASC' }));
      const badSort = sortItems.filter(({ field }) => !COMPARISON_SORT_FIELDS.includes(field));
      if (badSort.length > 0) {
        throw badInput(
          `Invalid sort field(s): ${badSort.map(({ field }) => previewValue(field)).join(', ')}. ` +
            `Allowed: ${COMPARISON_SORT_FIELDS.join(', ')}.`,
        );
      }

      // Métadonnées des deux côtés
      const sides = await Promise.all([
        loadSideMetadata(loaders, catalogA, schemaA ?? null),
        loadSideMetadata(loaders, catalogB, schemaB ?? null),
      ]);

      // Mesure : argument, sinon value (présente des deux côtés)
      const effectiveMeasure = measure ?? DEFAULT_MEASURE;
      if (!measure && sides.some((side) => !side.byName.has(DEFAULT_MEASURE))) {
        throw badInput(
          `No measure given and no column ${DEFAULT_MEASURE} in ` +
            `${sides.map((side) => side.name).join(' and ')}; pass measure.`,
        );
      }

      // Colonnes contrôlées des deux côtés, agrégation résolue de chaque côté
      const [aggregationA, aggregationB] = sides.map((side) => {
        assertColumns(joinFields, side.byName, `joinField (${side.name})`);
        assertColumns([effectiveMeasure], side.byName, `measure (${side.name})`);
        return comparedAggregation(aggregation, side.byName.get(effectiveMeasure)!);
      });
      assertSameAggregation(effectiveMeasure, aggregationA, aggregationB);

      // Libellé de la clé seulement pour un champ de jointure unique
      const [labelFieldA, labelFieldB] = sides.map((side) =>
        joinFields.length === 1 ? resolveLabelField(joinFields[0], side.byName) : null,
      );

      const result = await withTimeout(
        loaders.compareFacts.load({
          catalogA,
          catalogB,
          schemaA,
          schemaB,
          joinFields,
          measure: effectiveMeasure,
          aggregation: aggregationA,
          labelFieldA,
          labelFieldB,
          limit,
          offset,
          sort: sortItems,
        } as CompareFactsParams),
        config.API.TIMEOUTS.FACT_COMPLEX,
        'compareFacts timeout',
      );
      return { ...result, measure: effectiveMeasure, aggregation: aggregationA };
    },

    /**
     * Compares several aggregates across two datasets, one row per group.
     * Arguments follow the generated `QueryCompareAggregatedFactsArgs`.
     *
     * Each side is resolved by resolveAggregateParams against its own
     * metadata (same rules as getAggregates); both resolutions must then agree
     * on the effective aggregation of each aggregate and on the truncation of
     * each group column, and every aggregate must yield a number.
     *
     * @param _ - Parent resolver result (unused at root).
     * @returns The page, its columns and the description of each column.
     * @throws {GraphQLError} When cross-catalog is disabled, catalogs are
     *     invalid, or an argument is invalid on either side.
     */
    // Comparaison de plusieurs agrégats entre deux datasets
    compareAggregatedFacts: async (
      _,
      { catalogA, catalogB, schemaA, schemaB, groupBy, aggregates, sort, limit, offset },
      { loaders },
    ) => {
      // Vérification de l'activation des requêtes cross-catalog
      assertCrossDatabaseAllowed();

      // Validation des identifiants de catalogues
      [catalogA, catalogB].forEach(assertValidCatalog);

      // Validation de la pagination
      validatePagination(limit, offset);

      // Métadonnées des deux côtés
      const sides = await Promise.all([
        loadSideMetadata(loaders, catalogA, schemaA ?? null),
        loadSideMetadata(loaders, catalogB, schemaB ?? null),
      ]);

      // Résolution de chaque côté contre ses propres métadonnées (colonnes
      // contrôlées d'abord, pour nommer le côté fautif)
      const groupFields = (groupBy ?? []).map((group) => group.field);
      const [resolvedA, resolvedB]: ResolvedAggregateParams[] = sides.map((side) => {
        assertColumns(groupFields, side.byName, `groupBy (${side.name})`);
        assertColumns(
          (aggregates ?? []).map((aggregate) => aggregate.measure),
          side.byName,
          `measure (${side.name})`,
        );
        const resolved = resolveAggregateParams(
          { groupBy, aggregates, includeRowCount: false },
          side.byName,
        );
        resolved.aggregates.forEach(({ aggregation, measure }) =>
          assertNumericAggregate(aggregation, side.byName.get(measure)!),
        );
        return resolved;
      });

      // Même agrégation et même troncature des deux côtés
      resolvedA.aggregates.forEach((aggregate, i) =>
        assertSameAggregation(
          aggregate.measure,
          aggregate.aggregation,
          resolvedB.aggregates[i].aggregation,
        ),
      );
      resolvedA.groups.forEach((group, i) => {
        if (group.truncation !== resolvedB.groups[i].truncation) {
          throw badInput(
            `groupBy ${previewValue(group.field)} is truncated as a ${group.truncation} in ` +
              `dataset A and as a ${resolvedB.groups[i].truncation} in dataset B: the groups ` +
              'would never match.',
          );
        }
      });

      // Colonnes de sortie : groupes, libellés, quatre colonnes par agrégat ; uniques
      const labelled = resolvedA.groups.filter(
        (group, i) => group.labelField || resolvedB.groups[i].labelField,
      );
      const outputColumns = [
        ...groupFields,
        ...labelled.map((group) => labelColumnOf(group.field)),
        ...resolvedA.aggregates.flatMap((aggregate) => comparedColumnsOf(aggregate.alias)),
      ];
      const duplicate = outputColumns.find((name, index) => outputColumns.indexOf(name) !== index);
      if (duplicate !== undefined) {
        throw badInput(
          `Output column ${previewValue(duplicate)} is produced more than once (group columns, ` +
            'label columns and <alias>_a/_b/_delta/_delta_pct must have distinct names); ' +
            'set a distinct alias.',
        );
      }
      const resolvedSort = resolveComparisonSort(sort, outputColumns, groupFields);

      const page = await withTimeout(
        loaders.compareAggregatedFacts.load({
          catalogA,
          catalogB,
          schemaA,
          schemaB,
          sideA: { groups: resolvedA.groups, aggregates: resolvedA.aggregates },
          sideB: { groups: resolvedB.groups, aggregates: resolvedB.aggregates },
          sort: resolvedSort,
          limit,
          offset,
        } as CompareAggregatedFactsParams),
        config.API.TIMEOUTS.AGGREGATED_COMPLEX,
        'compareAggregatedFacts timeout',
      );

      // Description des colonnes : métadonnées du côté A, type lu dans le résultat
      const metadataA = sides[0].byName;
      const scope = effectiveScope(catalogA, schemaA);
      const typeOf = (column: string): string =>
        page.columnTypes[page.columns.indexOf(column)] ?? 'NULL';
      const labelledFields = new Set(labelled.map((group) => group.field));

      return {
        groupBy: resolvedA.groups.map((group) => ({
          name: group.field,
          grain: group.grain,
          labelColumn: labelledFields.has(group.field) ? labelColumnOf(group.field) : null,
          field: attachScope(metadataA.get(group.field)!, scope)!,
          extent: page.extents[group.field] ?? null,
        })),
        aggregates: resolvedA.aggregates.map(({ measure, aggregation, alias }) => {
          const measureMeta = metadataA.get(measure)!;
          const [columnA, columnB] = comparedColumnsOf(alias);
          return {
            alias,
            measure,
            aggregation,
            sqlType: typeOf(columnA),
            unit: aggregateUnit(aggregation, measureMeta),
            displayFormat: aggregateDisplayFormat(aggregation, measureMeta),
            field: attachScope(measureMeta, scope)!,
            extent: mergeExtents(page.extents[columnA], page.extents[columnB]),
          };
        }),
        columns: page.columns,
        data: page.data,
        total: page.total,
        hasNextPage: offset + limit < page.total,
        generatedAt: new Date().toISOString(),
      };
    },

    /**
     * Fetches select options for a field across multiple datasets.
     * Arguments follow the generated `QueryCrossDatabaseSelectOptionsArgs`.
     *
     * @param _ - Parent resolver result (unused at root).
     * @returns Merged list of select options from all datasets.
     * @throws {GraphQLError} When cross-catalog is disabled, fewer than two
     *     catalogs are specified, or any alias is invalid.
     */
    // Récupération des options de sélection sur plusieurs datasets
    crossDatabaseSelectOptions: async (_, { fieldName, catalogs, schemas, limit }, { loaders }) => {
      // Vérification de l'activation des requêtes cross-catalog
      assertCrossDatabaseAllowed();

      // Vérification de la présence d'au moins deux catalogues
      if (!catalogs || catalogs.length < 2) {
        throw badInput('At least two catalogs must be specified');
      }

      // Validation de chaque identifiant de catalogue
      catalogs.forEach(assertValidCatalog);

      // Validation de la limite
      validatePagination(limit);

      // Champ contrôlé contre les métadonnées de chaque cible
      await Promise.all(
        catalogs.map(async (catalog, i) => {
          const side = await loadSideMetadata(loaders, catalog, schemas?.[i] ?? null);
          assertColumns([fieldName], side.byName, `fieldName (${side.name})`);
        }),
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
