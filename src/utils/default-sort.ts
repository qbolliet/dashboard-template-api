// Importation des modules
import { assertColumns } from './identifiers.js';
import { createContextLogger } from './logger.js';
import { indexMetadataByName } from './metadata-mapping.js';
import type { SortItem } from '../loaders/base-loader.js';
import type { LoadersCollection } from '../loaders/index.js';

/**
 * Field name of the sort item that stands for `ORDER BY ALL`.
 *
 * The empty string cannot collide with a column: DuckDB refuses a zero-length
 * identifier and the metadata contract requires non-empty names. The item is
 * plain data, so it enters the cache key like any other sort; the SQL builder
 * (FactQueryLoader.buildSortClause) renders it.
 */
const ALL_COLUMNS_FIELD = '';

/** Sort of last resort: every selected column, in order (`ORDER BY ALL`). */
const ALL_COLUMNS_SORT: SortItem = { field: ALL_COLUMNS_FIELD, order: 'ASC' };

const sortLogger = createContextLogger({ component: 'loaders', module: 'default-sort' });

// Schémas dont l'absence de clé a déjà été signalée (un avertissement par schéma)
const warnedWithoutKey = new Set<string>();

/**
 * Warns, once per schema, that pagination falls back on every column.
 *
 * @param catalog - Catalog alias of the query.
 * @param schema - Schema of the query, or null for the catalog default.
 */
// Avertissement unique par schéma : ni cluster_by ni clé primaire exploitable
function warnWithoutKey(catalog: string, schema: string | null | undefined): void {
  const key = `${catalog}.${schema ?? ''}`;
  if (warnedWithoutKey.has(key)) return;
  warnedWithoutKey.add(key);
  sortLogger.warn(
    `No usable cluster_by nor primary key for ${catalog}${schema ? `.${schema}` : ''}: ` +
      'pages are ordered by every column (ORDER BY ALL), which sorts the whole table for each page',
    { catalog, schema: schema ?? null },
  );
}

/** Forgets the schemas already warned about (tests). */
function resetWithoutKeyWarnings(): void {
  warnedWithoutKey.clear();
}

// ─── Tri par défaut et départage ─────────────────────────────────────────────

/**
 * Deterministic default ordering for fact table pagination.
 *
 * Offset pagination without an ORDER BY is not stable under DuckDB: the scan
 * is parallel and spans several files, so two successive pages are neither
 * guaranteed disjoint nor jointly exhaustive. The database gives the natural
 * remedy — `dataset_metadata.cluster_by`, the physical write order — which
 * makes the default sort nearly free as long as the reclustering maintenance
 * is kept up (revue-technique-api.md §5.7).
 */

/**
 * Resolves the ORDER BY actually applied to a fact table query.
 *
 * Without an explicit sort, the schema's `clusterBy` columns order the result,
 * falling back to the primary keys when `cluster_by` is absent or unusable,
 * and to `ORDER BY ALL` when the schema has no primary key either (the writer
 * deduplicates on every column then, so all columns make a total order); that
 * fallback is warned about once per schema.
 * With an explicit sort, the primary keys not already named are appended as
 * tiebreakers, so pages stay disjoint even when the sort column has ties; a
 * schema without primary key gets every other column as tiebreakers, in table
 * order (`ORDER BY ALL` cannot follow an explicit sort).
 *
 * Every column is checked against the metadata of the schema — whatever its
 * name, since it is quoted in the SQL. An explicit sort on an unknown column
 * is a client error; a stale `cluster_by`, naming a column that has since
 * been dropped, is silently skipped so that it never produces invalid SQL.
 *
 * @param explicitSort - Sort items supplied by the client, if any.
 * @param activeLoaders - Loaders bound to the target catalog/schema.
 * @param catalog - Catalog alias of the query.
 * @param schema - Schema of the query, or null for the catalog default.
 * @returns The effective sort items, possibly empty.
 * @throws {GraphQLError} BAD_USER_INPUT when an explicit sort column is unknown.
 */
// Tri effectif : cluster_by par défaut, clés primaires en départage
async function resolveEffectiveSort(
  explicitSort: SortItem[] | null | undefined,
  activeLoaders: LoadersCollection,
  catalog: string,
  schema?: string | null,
): Promise<SortItem[]> {
  const fields = await activeLoaders.catalogMetadata.load({ catalog, schema });
  const byName = indexMetadataByName(fields);
  const primaryKeys = fields.filter((f) => f.isPrimaryKey).map((f) => f.name);

  // Colonnes retenues : connues du schéma, quel que soit leur nom
  const usable = (columns: string[]): string[] => columns.filter((column) => byName.has(column));

  if (!explicitSort || explicitSort.length === 0) {
    const info = await activeLoaders.datasetInfo.load({ catalog, schema });
    // Repli sur les clés primaires quand cluster_by est absente ou périmée
    const columns = usable(info.clusterBy);
    const ordering = columns.length > 0 ? columns : usable(primaryKeys);
    if (ordering.length > 0) return ordering.map((field) => ({ field, order: 'ASC' as const }));

    // Dernier repli : toutes les colonnes (le writer dédoublonne sur toutes les colonnes)
    warnWithoutKey(catalog, schema);
    return [ALL_COLUMNS_SORT];
  }

  // Tri explicite : colonnes contrôlées contre metadata
  assertColumns(
    explicitSort.map((s) => s.field),
    byName,
    'sort',
  );

  // Départage : les clés primaires absentes du tri explicite, sans doublon ;
  // sans clé primaire, toutes les colonnes dans l'ordre de la table
  const named = new Set(explicitSort.map((s) => s.field));
  const keys = usable(primaryKeys);
  if (keys.length === 0) warnWithoutKey(catalog, schema);
  const tiebreakers = (keys.length > 0 ? keys : fields.map((f) => f.name))
    .filter((field) => !named.has(field))
    .map((field) => ({ field, order: 'ASC' as const }));

  return [...explicitSort, ...tiebreakers];
}

export { resolveEffectiveSort, resetWithoutKeyWarnings, ALL_COLUMNS_FIELD, ALL_COLUMNS_SORT };
