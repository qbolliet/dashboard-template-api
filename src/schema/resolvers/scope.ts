// Importation des modules
import { GraphQLError } from 'graphql';
import { databaseManager } from '../../db/index.js';
import type { GraphQLContext } from './types.js';
import type { LoadersCollection } from '../../loaders/index.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Effective (catalog, schema) pair a piece of data was read from. */
export interface FieldScope {
  catalog: string;
  schema: string;
}

/**
 * Internal fields carried by a Metadata parent object.
 *
 * Not declared in the SDL, so never exposed: they only let the lazy
 * `Metadata.stats` resolver know which catalog and schema to query.
 */
export interface ScopeFields {
  _catalog?: string;
  _schema?: string;
}

// ─── Validation d'un schéma ───────────────────────────────────────────────────

/**
 * Validates an optional schema argument against the catalog's allow-list.
 *
 * The schema must belong to the configured (and optionally SQL-discovered)
 * list of schemas for the catalog. This is stricter than a regex check on the
 * identifier shape: it rejects syntactically valid but unknown schemas before
 * any string is interpolated into SQL.
 *
 * @param catalog - Catalog the schema must belong to.
 * @param schema - Schema name to validate, or null/undefined to skip.
 * @throws {GraphQLError} When the schema is not in the catalog's allow-list.
 */
// Validation d'un schéma optionnel contre l'allow-list du catalogue
export function validateSchemaForCatalog(catalog: string, schema?: string | null): void {
  if (!schema) return;
  if (!databaseManager.isValidSchema(catalog, schema)) {
    throw new GraphQLError(
      `Schema '${schema}' is not available for catalog '${catalog}'. ` +
        `Available: ${databaseManager.getSchemas(catalog).join(', ')}`,
    );
  }
}

// ─── Résolution du scope ──────────────────────────────────────────────────────

/**
 * Builds the effective scope of an already validated catalog.
 *
 * @param catalog - Validated catalog alias.
 * @param schema - Requested schema, or null/undefined for the catalog default.
 * @returns The scope, with the schema resolved to a concrete name.
 */
// Scope effectif : le schéma absent devient le schéma par défaut du catalogue
export function effectiveScope(catalog: string, schema?: string | null): FieldScope {
  return { catalog, schema: schema || databaseManager.getDefaultSchema(catalog) };
}

/**
 * Resolves the scope of a query from its arguments and the request context.
 *
 * Same precedence as `getLoadersForCatalog`: GraphQL argument, then HTTP
 * header (`requestCatalog` / `requestSchema`), then the configured default.
 *
 * @param context - GraphQL context of the request.
 * @param catalog - Catalog argument of the query, if any.
 * @param schema - Schema argument of the query, if any.
 * @returns The effective catalog and schema.
 * @throws {Error} When the catalog is unknown.
 * @throws {GraphQLError} When the schema is not in the catalog's allow-list.
 */
// Scope d'une requête : argument, puis en-tête HTTP, puis défaut
export function contextScope(
  context: Partial<Pick<GraphQLContext, 'requestCatalog' | 'requestSchema'>>,
  catalog?: string | null,
  schema?: string | null,
): FieldScope {
  const targetCatalog = databaseManager.validateCatalogRouting(
    catalog ?? null,
    context.requestCatalog ?? null,
  );
  validateSchemaForCatalog(targetCatalog, schema);
  return effectiveScope(targetCatalog, schema ?? context.requestSchema);
}

// ─── Rattachement du scope aux objets Metadata ───────────────────────────────

/**
 * Attaches the scope to a Metadata object, without mutating it.
 *
 * The object may come from a DataLoader cache shared within the request, so a
 * copy carries the internal `_catalog` / `_schema` fields.
 *
 * @param metadata - Metadata row, or null (e.g. an unknown field).
 * @param scope - Scope the row was read from.
 * @returns The row with its scope, or null when there is no row.
 */
// Copie de la métadonnée portant son catalogue et son schéma
export function attachScope<T extends object>(
  metadata: T | null | undefined,
  scope: FieldScope,
): (T & ScopeFields) | null {
  if (!metadata) return null;
  return { ...metadata, _catalog: scope.catalog, _schema: scope.schema };
}

/**
 * Attaches the scope to every Metadata object of a list.
 *
 * @param rows - Metadata rows of one scope.
 * @param scope - Scope the rows were read from.
 * @returns The rows with their scope.
 */
// Rattachement du scope à une liste de métadonnées
export function attachScopeToAll<T extends object>(
  rows: readonly T[],
  scope: FieldScope,
): (T & ScopeFields)[] {
  return rows.map((row) => ({ ...row, _catalog: scope.catalog, _schema: scope.schema }));
}

// ─── Loaders d'un scope ───────────────────────────────────────────────────────

// Loaders déjà construits pour une requête, par scope : N champs `stats` d'un même
// schéma partagent une seule collection (donc le cache DataLoader de la requête).
const loadersByRequest = new WeakMap<object, Map<string, LoadersCollection>>();

/**
 * Returns the loaders bound to a scope, built once per request and scope.
 *
 * @param context - GraphQL context of the request.
 * @param scope - Effective catalog and schema.
 * @returns The loaders of the scope (the request's own when it is the same one).
 */
// Loaders d'un scope, mémoïsés pour la durée de la requête
export function loadersForScope(context: GraphQLContext, scope: FieldScope): LoadersCollection {
  let byScope = loadersByRequest.get(context);
  if (!byScope) {
    byScope = new Map();
    loadersByRequest.set(context, byScope);
  }
  const key = `${scope.catalog}\u0000${scope.schema}`;
  let loaders = byScope.get(key);
  if (!loaders) {
    loaders = context.getLoadersForCatalog(scope.catalog, scope.schema) ?? context.loaders;
    byScope.set(key, loaders);
  }
  return loaders;
}
