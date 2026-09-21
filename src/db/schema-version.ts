// Importation des modules
import { GraphQLError } from 'graphql';
import { config } from '../utils/config-loader.js';
import { createContextLogger } from '../utils/logger.js';

// ─── Garde de version du schéma de base ──────────────────────────────────────

/**
 * Schema version guard for DuckLake catalogs.
 *
 * The database declares its format through `dataset_metadata.schema_version`
 * (specification-bdd.md §2.3). A catalog written in an older format — one
 * without a `dataset_metadata` table at all — or in a version this API does not
 * support must not be read as if it were conformant.
 *
 * The guard is probed once per catalog/schema when catalogs are attached or
 * reloaded, and the verdict is cached here: query paths only read the cached
 * verdict, never the database. There is no compatibility path.
 */

const versionLogger = createContextLogger({
  component: 'database',
  module: 'schema-version',
});

/** Verdict recorded for one catalog/schema pair. */
interface SchemaVersionStatus {
  supported: boolean;
  /** Version read from dataset_metadata, or null when the table is unreachable. */
  version: number | null;
  /** Human-readable cause, used verbatim in the GraphQL error message. */
  reason: string;
}

// Verdicts constatés à l'attach, indexés par "catalogue.schéma".
// Cette carte EST le cache : aucune requête n'est émise depuis le chemin de lecture.
const statuses = new Map<string, SchemaVersionStatus>();

/**
 * Returns the list of schema versions this API supports.
 *
 * Accepts both the parsed array and the JSON string form, like the other
 * array-valued configuration entries (ALLOWED_CATALOGS, SCHEMAS).
 *
 * @returns Supported schema versions.
 */
// Lecture de la configuration, tolérante à la forme chaîne JSON des variables d'env
function getSupportedVersions(): number[] {
  const raw = config.SUPPORTED_SCHEMA_VERSIONS;
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed)) return [1];
  return parsed.map((v) => Number(v)).filter((v) => Number.isFinite(v));
}

/**
 * Builds the map key of a catalog/schema pair.
 *
 * @param catalog - Catalog alias.
 * @param schema - Schema name within the catalog.
 * @returns The composite key.
 */
function statusKey(catalog: string, schema: string): string {
  return `${catalog}.${schema}`;
}

/**
 * Records the verdict for one catalog/schema and warns when it is unsupported.
 *
 * @param catalog - Catalog alias.
 * @param schema - Schema name within the catalog.
 * @param version - Version read from dataset_metadata, or null when unreachable.
 */
// Enregistrement du verdict, avec avertissement explicite à l'attach/reload
function recordSchemaVersion(catalog: string, schema: string, version: number | null): void {
  const supported = getSupportedVersions();

  let status: SchemaVersionStatus;
  if (version === null) {
    status = {
      supported: false,
      version: null,
      reason: 'the dataset_metadata table is missing or empty (catalog in a legacy format)',
    };
  } else if (!supported.includes(version)) {
    status = {
      supported: false,
      version,
      reason: `schema version ${version} is not supported (supported: ${supported.join(', ')})`,
    };
  } else {
    status = { supported: true, version, reason: '' };
  }

  statuses.set(statusKey(catalog, schema), status);

  if (!status.supported) {
    versionLogger.warn(`Unsupported schema version for ${catalog}.${schema}`, {
      catalog,
      schema,
      version,
      supported,
      reason: status.reason,
    });
  }
}

/**
 * Clears every recorded verdict.
 *
 * Called before re-probing so a schema that disappeared from a catalog does not
 * keep a stale verdict.
 */
function resetSchemaVersions(): void {
  statuses.clear();
}

/**
 * Throws when the given catalog/schema is not readable by this API.
 *
 * A pair that was never probed is left alone: the guard must not turn an
 * un-probed schema into an error, only report what the attach step observed.
 *
 * @param catalog - Catalog alias being queried.
 * @param schema - Schema name being queried.
 * @throws {GraphQLError} SCHEMA_VERSION_UNSUPPORTED when the schema is unsupported.
 */
// Garde appliquée à toute requête touchant un schéma
function assertSchemaSupported(catalog: string, schema: string): void {
  const status = statuses.get(statusKey(catalog, schema));
  if (!status || status.supported) return;

  throw new GraphQLError(
    `Catalog '${catalog}', schema '${schema}': ${status.reason}. ` +
      'This schema cannot be queried by this version of the API.',
    {
      extensions: { code: 'SCHEMA_VERSION_UNSUPPORTED', catalog, schema, version: status.version },
    },
  );
}

/**
 * Returns the recorded verdict of a catalog/schema, for diagnostics.
 *
 * @param catalog - Catalog alias.
 * @param schema - Schema name within the catalog.
 * @returns The recorded status, or undefined when the pair was never probed.
 */
function getSchemaVersionStatus(catalog: string, schema: string): SchemaVersionStatus | undefined {
  return statuses.get(statusKey(catalog, schema));
}

export {
  assertSchemaSupported,
  getSchemaVersionStatus,
  getSupportedVersions,
  recordSchemaVersion,
  resetSchemaVersions,
};
export type { SchemaVersionStatus };
