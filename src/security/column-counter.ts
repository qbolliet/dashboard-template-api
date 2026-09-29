// Importation des modules
import { databaseManager } from '../db/index.js';
import { assertSchemaSupported } from '../db/schema-version.js';
import { contextScope } from '../schema/resolvers/scope.js';
import type { ColumnCounter } from './complexity-analyzer.js';
import type { CatalogSchemaKey } from '../loaders/catalog.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** The part of the request loaders the counter reads. */
interface CatalogMetadataSource {
  catalogMetadata: { load(key: CatalogSchemaKey): Promise<readonly unknown[]> };
}

// ─── Compteur de colonnes ────────────────────────────────────────────────────

/**
 * Normalizes a GraphQL argument value into an optional identifier.
 *
 * @param value - Argument value read from the operation.
 * @returns The string, or null for any other value.
 */
const asIdentifier = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Tells whether a schema passes the version guard, without reading it.
 *
 * An unsupported schema is refused by its resolver before any `stats` runs:
 * probing it would only log a loader error.
 *
 * @param catalog - Resolved catalog.
 * @param schema - Resolved schema.
 * @returns True when the schema version is supported.
 */
const isSupported = (catalog: string, schema: string): boolean => {
  try {
    assertSchemaSupported(catalog, schema);
    return true;
  } catch {
    return false;
  }
};

/**
 * Builds the column counter of a request, used to price `Metadata.stats`.
 *
 * Counts are read through the request's own `catalogMetadata` DataLoader —
 * the one the resolvers use, keyed identically — so the metadata read here
 * (from the Redis cache, or a small query on the `metadata` table) is not
 * read again by the resolver. Counts are memoized per (catalog, schema).
 *
 * A target that cannot be counted (unknown catalog or schema, unsupported
 * schema version, read failure) counts 0 columns: its resolver fails with the
 * same error, so no `stats` query runs for it.
 *
 * @param loaders - Loaders of the request.
 * @returns The column counter of the request.
 */
function createColumnCounter(loaders: CatalogMetadataSource): ColumnCounter {
  const counts = new Map<string, Promise<number>>();

  // Nombre de colonnes d'une cible résolue, mémoïsé
  const countOf = (catalog: string, schema: string): Promise<number> => {
    const key = `${catalog}\u0000${schema}`;
    let pending = counts.get(key);
    if (!pending) {
      pending = isSupported(catalog, schema)
        ? loaders.catalogMetadata.load({ catalog, schema }).then(
            (rows) => rows.length,
            () => 0,
          )
        : Promise.resolve(0);
      counts.set(key, pending);
    }
    return pending;
  };

  return {
    columnsOf: async (catalog: unknown, schema: unknown): Promise<number> => {
      // Même résolution que les resolvers : argument, sinon défaut du catalogue
      let scope;
      try {
        scope = contextScope(asIdentifier(catalog), asIdentifier(schema));
      } catch {
        return 0;
      }
      return countOf(scope.catalog, scope.schema);
    },

    allColumns: async (): Promise<number> => {
      // Toutes les colonnes de tous les schémas de tous les catalogues
      const targets = databaseManager
        .getAvailableCatalogs()
        .flatMap((catalog) =>
          databaseManager.getSchemas(catalog).map((schema) => countOf(catalog, schema)),
        );
      const perSchema = await Promise.all(targets);
      return perSchema.reduce((total, count) => total + count, 0);
    },
  };
}

export { createColumnCounter };
export type { CatalogMetadataSource };
