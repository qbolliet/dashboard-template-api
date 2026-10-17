// Importation des modules
import { GraphQLError } from 'graphql';
import { withTimeout } from '../../utils/timeout.js';
import { config } from '../../utils/config-loader.js';
import { compileFilterTree } from '../../utils/filter-tree.js';
import { indexMetadataByName } from '../../utils/metadata-mapping.js';
import { validatePagination } from '../../utils/pagination.js';
import {
  aggregateDisplayFormat,
  aggregateUnit,
  labelColumnOf,
  longColumns,
  meltRows,
  resolveAggregateParams,
} from '../../utils/aggregate-query.js';
import { attachScope, contextScope } from './scope.js';
import type { Json } from '@duckdb/node-api';
import type { FieldMetadata } from '../../utils/metadata-mapping.js';
import type { FieldScope, ScopeFields } from './scope.js';
import type { QueryResolvers } from '../../generated/graphql.js';

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

/** Message of the timeout of an aggregate query, kept apart from other failures. */
const TIMEOUT_MESSAGE = 'Aggregates fetch timeout';

/**
 * Attaches the scope to a Metadata row known to exist.
 *
 * @param field - Metadata row of a checked column.
 * @param scope - Scope the row was read from.
 * @returns The row with its scope, for the lazy `stats` field.
 */
// Métadonnée d'une colonne contrôlée, rattachée à son scope
function scoped(field: FieldMetadata, scope: FieldScope): FieldMetadata & ScopeFields {
  return attachScope(field, scope)!;
}

// Resolver de la requête d'agrégats
/**
 * Resolvers of the aggregate query.
 *
 * getAggregates computes several aggregates over zero, one or several group
 * columns (optionally truncated to a time grain) in one SQL query, and
 * describes each column so that a client draws axes, headers and tooltips
 * without a second request.
 */
const aggregatesResolvers: { Query: Pick<QueryResolvers, 'getAggregates'> } = {
  Query: {
    /**
     * Fetches one page of aggregates.
     * Arguments follow the generated `QueryGetAggregatesArgs`.
     *
     * Validates the page, then resolves the request against the metadata of
     * every group column and measure (resolveAggregateParams): the resolved
     * parameters, the compiled filter and the page form the cache key. The
     * page and the group count are loaded in parallel, each with its own cache
     * entry; without group columns the total is 1 and nothing is counted. The
     * format is applied last, so OBJECTS, ARRAYS and LONG share one entry.
     *
     * @param _ - Parent resolver result (unused at root).
     * @returns The page, its columns and the description of each column.
     * @throws {GraphQLError} BAD_USER_INPUT on an invalid argument.
     */
    getAggregates: async (
      _,
      {
        groupBy,
        aggregates,
        structuredFilters,
        sort,
        limit,
        offset,
        format,
        includeRowCount,
        catalog,
        schema,
      },
      { loaders, getLoadersForCatalog },
    ) => {
      // Pagination validée avant tout accès à la base
      validatePagination(limit, offset);

      const activeLoaders = getLoadersForCatalog(catalog, schema) ?? loaders;
      const scope = contextScope(catalog, schema);
      const effectiveFormat = format ?? 'OBJECTS';

      // Métadonnées des colonnes de groupe et des mesures (libellés compris)
      const names = [
        ...new Set([
          ...(groupBy ?? []).map((group) => group.field),
          ...(aggregates ?? []).map((aggregate) => aggregate.measure),
        ]),
      ];
      const rows = await withTimeout(
        activeLoaders.metadata.loadMany(names),
        config.API.TIMEOUTS.METADATA,
        'Metadata fetch timeout',
      );
      const failure = rows.find((row): row is Error => row instanceof Error);
      if (failure) throw failure;
      const metadataByName = indexMetadataByName(rows as (FieldMetadata | null)[]);

      // Paramètres résolus : la clé de cache
      const resolved = resolveAggregateParams(
        { groupBy, aggregates, sort, includeRowCount, format: effectiveFormat },
        metadataByName,
      );

      try {
        // Compilation de l'arbre de filtres avec les métadonnées du dataset cible
        const where = await compileFilterTree(structuredFilters, (filterNames) =>
          activeLoaders.metadata.loadMany(filterNames),
        );

        // Page et comptage en parallèle ; sans groupe, une seule ligne
        const [page, total] = await withTimeout(
          Promise.all([
            activeLoaders.aggregates.load({ ...resolved, where, limit, offset }),
            resolved.groups.length > 0
              ? activeLoaders.aggregateGroupCount.load({ groups: resolved.groups, where })
              : Promise.resolve(1),
          ]),
          config.API.TIMEOUTS.AGGREGATED_COMPLEX,
          TIMEOUT_MESSAGE,
        );

        // Description des colonnes : type lu dans le résultat, extents de la page
        const typeOf = (column: string): string =>
          page.columnTypes[page.columns.indexOf(column)] ?? 'NULL';
        const aliases = resolved.aggregates.map((aggregate) => aggregate.alias);

        // Mise en forme demandée
        let columns: string[] = page.columns;
        let data: Json[] = page.data;
        if (effectiveFormat === 'LONG') {
          columns = longColumns(page.columns, aliases);
          data = meltRows(page.data, page.columns, aliases);
        } else if (effectiveFormat === 'ARRAYS') {
          data = page.data.map((row) => page.columns.map((column) => row[column] ?? null));
        }

        return {
          groupBy: resolved.groups.map((group) => ({
            name: group.field,
            grain: group.grain,
            labelColumn: group.labelField ? labelColumnOf(group.field) : null,
            field: scoped(metadataByName.get(group.field)!, scope),
            extent: page.extents[group.field] ?? null,
          })),
          aggregates: resolved.aggregates.map(({ measure, aggregation, alias }) => {
            const measureMeta = metadataByName.get(measure)!;
            return {
              alias,
              measure,
              aggregation,
              sqlType: typeOf(alias),
              unit: aggregateUnit(aggregation, measureMeta),
              displayFormat: aggregateDisplayFormat(aggregation, measureMeta),
              field: scoped(measureMeta, scope),
              extent: page.extents[alias] ?? null,
            };
          }),
          columns,
          data,
          total,
          hasNextPage: offset + limit < total,
          generatedAt: new Date().toISOString(),
        };
      } catch (error) {
        // Les erreurs de validation (BAD_USER_INPUT) remontent telles quelles au client
        if (error instanceof GraphQLError) throw error;
        if ((error as Error).message === TIMEOUT_MESSAGE) throw error;
        throw new Error('Failed to fetch aggregates', { cause: error });
      }
    },
  },
};

export { aggregatesResolvers };
