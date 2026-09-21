// Importation des modules
import { validateIdentifier } from './utils.js';
import type { SortItem } from '../loaders/base-loader.js';
import type { LoadersCollection } from '../loaders/index.js';

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
 * falling back to the primary keys when `cluster_by` is absent or unusable.
 * With an explicit sort, the primary keys not already named are appended as
 * tiebreakers, so pages stay disjoint even when the sort column has ties.
 *
 * Every column is validated as a SQL identifier and checked against the
 * metadata of the schema: a stale `cluster_by`, naming a column that has since
 * been dropped, must not produce invalid SQL.
 *
 * @param explicitSort - Sort items supplied by the client, if any.
 * @param activeLoaders - Loaders bound to the target catalog/schema.
 * @param catalog - Catalog alias of the query.
 * @param schema - Schema of the query, or null for the catalog default.
 * @returns The effective sort items, possibly empty.
 */
// Tri effectif : cluster_by par défaut, clés primaires en départage
async function resolveEffectiveSort(
  explicitSort: SortItem[] | null | undefined,
  activeLoaders: LoadersCollection,
  catalog: string,
  schema?: string | null,
): Promise<SortItem[]> {
  const fields = await activeLoaders.catalogMetadata.load({ catalog, schema });
  const known = new Set(fields.map((f) => f.name));
  const primaryKeys = fields.filter((f) => f.isPrimaryKey).map((f) => f.name);

  // Colonnes retenues : connues du schéma et valides comme identifiants SQL
  const usable = (columns: string[]): string[] =>
    columns.filter((column) => {
      if (!known.has(column)) return false;
      try {
        validateIdentifier(column, 'sortField');
        return true;
      } catch {
        return false;
      }
    });

  if (!explicitSort || explicitSort.length === 0) {
    const info = await activeLoaders.datasetInfo.load({ catalog, schema });
    // Repli sur les clés primaires quand cluster_by est absente ou périmée
    const columns = usable(info.clusterBy);
    const ordering = columns.length > 0 ? columns : usable(primaryKeys);
    return ordering.map((field) => ({ field, order: 'ASC' as const }));
  }

  // Départage : les clés primaires absentes du tri explicite, sans doublon
  const named = new Set(explicitSort.map((s) => s.field));
  const tiebreakers = usable(primaryKeys)
    .filter((field) => !named.has(field))
    .map((field) => ({ field, order: 'ASC' as const }));

  return [...explicitSort, ...tiebreakers];
}

export { resolveEffectiveSort };
