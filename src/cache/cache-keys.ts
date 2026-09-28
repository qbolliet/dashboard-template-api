// Construction des clés Redis versionnées par les données servies

/**
 * Returns the data version served for a catalog/schema
 * (see `DatabaseManager.getDataVersion`).
 */
type DataVersionLookup = (catalog: string, schema: string) => string;

/** Parts of a cache key, before versioning. */
interface CacheKeyParts {
  /** Cache type (facts, metadata, select-options…). */
  prefix: string;
  /** Resolved catalog, or `a+b` for a key spanning several catalogs. */
  catalog: string;
  /** Resolved schema, or `s1+s2` (aligned with `catalog`) for several schemas. */
  schema: string;
  /** Optional variant separating loaders of one prefix; '' when none. */
  variant?: string;
  /** Hash of the canonical key object. */
  hash: string;
}

// Séparateur des cibles d'une clé composite (cross-database)
const TARGET_SEPARATOR = '+';

/**
 * Builds the versioned `<catalog>:<schema>@<version>` segment of a cache key.
 *
 * A composite namespace (`a+b` / `s1+s2`, produced by loaders reading several
 * schemas) versions every side — `a+b:s1@v1+s2@v2` — so an update of any side
 * moves the key. The version is the `updated_at` marker the live instance
 * serves: when it changes, entries computed on older data become unreachable
 * without any SCAN, and expire by TTL.
 *
 * @param catalog - Resolved catalog (or `+`-joined catalogs).
 * @param schema - Resolved schema (or `+`-joined schemas, aligned with catalogs).
 * @param versionOf - Lookup of the served data version.
 * @returns The versioned namespace segment.
 */
// Segment catalogue:schéma@version, chaque côté versionné pour une clé composite
function versionedSegment(catalog: string, schema: string, versionOf: DataVersionLookup): string {
  const catalogs = catalog.split(TARGET_SEPARATOR);
  const schemas = schema.split(TARGET_SEPARATOR);
  const versioned = schemas.map((s, i) => `${s}@${versionOf(catalogs[i] ?? catalogs[0], s)}`);
  return `${catalog}:${versioned.join(TARGET_SEPARATOR)}`;
}

/**
 * Builds a full cache key: `<prefix>:<catalog>:<schema>@<version>:<variant><hash>`.
 *
 * @param parts - Resolved key parts.
 * @param versionOf - Lookup of the served data version.
 * @returns The Redis key (without the client's key prefix).
 */
function buildCacheKey(parts: CacheKeyParts, versionOf: DataVersionLookup): string {
  const variant = parts.variant ? `${parts.variant}:` : '';
  return `${parts.prefix}:${versionedSegment(parts.catalog, parts.schema, versionOf)}:${variant}${parts.hash}`;
}

export { buildCacheKey, versionedSegment };
export type { CacheKeyParts, DataVersionLookup };
