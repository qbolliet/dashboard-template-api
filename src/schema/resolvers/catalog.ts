// Importation des modules
import { GraphQLError } from 'graphql';
import { databaseManager } from '../../db/index.js';
import type { GraphQLContext } from './types.js';
import type { CatalogMetadataRow } from '../../loaders/catalog.js';
import type { SelectOption } from '../../loaders/select-options.js';

// ─── Interfaces des arguments ─────────────────────────────────────────────────

/** Arguments for the getCatalogSchema query. */
export interface CatalogSchemaArgs {
  catalog?: string | null;
  schema?: string | null;
}

/** Arguments for the getFields query. */
export interface FieldsArgs {
  catalog?: string | null;
  schema?: string | null;
  sqlType?: string | null;
  isCategorical?: boolean | null;
  isPrimaryKey?: boolean | null;
  namePattern?: string | null;
}

/** A single (catalog, schema) target as accepted by getSharedDimensions. */
export interface CatalogSchemaTarget {
  catalog: string;
  schema?: string | null;
}

/** Arguments for the getSharedDimensions query. */
export interface SharedDimensionsArgs {
  targets: CatalogSchemaTarget[];
}

// ─── Interfaces des résultats ─────────────────────────────────────────────────

/**
 * Source object exposed by Catalog.schemas to resolve CatalogSchemaInfo
 * sub-fields. Carries the parent catalog id so that the `fields` and
 * `dimensionNames` field resolvers know which DataLoader key to use.
 */
export interface CatalogSchemaInfoSource {
  catalogId: string;
  name: string;
}

/** Catalog descriptor returned by getCatalogs. */
export interface CatalogEntry {
  id: string;
  defaultSchema: string;
  schemas: CatalogSchemaInfoSource[];
}

// ─── Fonction utilitaire ──────────────────────────────────────────────────────

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
function validateSchemaForCatalog(catalog: string, schema?: string | null): void {
  if (!schema) return;
  if (!databaseManager.isValidSchema(catalog, schema)) {
    throw new GraphQLError(
      `Schema '${schema}' is not available for catalog '${catalog}'. ` +
        `Available: ${databaseManager.getSchemas(catalog).join(', ')}`,
    );
  }
}

// Construction d'un resolver pour le catalogue multi-bases
/**
 * Resolvers for catalog introspection queries.
 *
 * Exposes the list of available catalogs and their schemas (with lazy
 * per-schema fields and dimension names via the CatalogSchemaInfo type
 * resolvers), the field metadata of a specific (catalog, schema) pair,
 * a filtered SelectOption view of those fields, and the intersection of
 * dimensions across several (catalog, schema) targets.
 */
const catalogResolvers = {
  // ── Type resolver: per-schema lazy loading of fields and dimension names ──
  CatalogSchemaInfo: {
    /**
     * Loads the metadata table rows of the schema this source describes.
     *
     * Invoked only when the client selects `fields` under `schemas { … }`,
     * so a query that asks for `schemas { name }` does not pay this cost.
     *
     * @param parent - Source object {catalogId, name} carried from Catalog.schemas.
     * @param _ - Field arguments (none).
     * @param context - GraphQL context with loaders.
     * @returns Array of catalog metadata rows for this schema.
     */
    fields: async (
      parent: CatalogSchemaInfoSource,
      _: Record<string, never>,
      { loaders }: GraphQLContext,
    ): Promise<CatalogMetadataRow[]> => {
      return loaders.catalogMetadata.load({ catalog: parent.catalogId, schema: parent.name });
    },

    /**
     * Loads the names of categorical fields in the schema this source describes.
     *
     * Invoked only when the client selects `dimensionNames` under `schemas { … }`.
     *
     * @param parent - Source object {catalogId, name} carried from Catalog.schemas.
     * @param _ - Field arguments (none).
     * @param context - GraphQL context with loaders.
     * @returns Array of categorical field names for this schema.
     */
    dimensionNames: async (
      parent: CatalogSchemaInfoSource,
      _: Record<string, never>,
      { loaders }: GraphQLContext,
    ): Promise<string[]> => {
      return loaders.catalogDimensionNames.load({
        catalog: parent.catalogId,
        schema: parent.name,
      });
    },
  },

  Query: {
    /**
     * Lists all available catalogs with their hosted schemas.
     *
     * Returns catalog identifiers and per-schema sources usable by the
     * CatalogSchemaInfo type resolvers. The `fields` and `dimensionNames`
     * sub-fields of each schema are loaded only when explicitly selected
     * by the client (lazy cascade via GraphQL selection sets).
     *
     * @param _ - Parent resolver result (unused at root).
     * @param __ - Query arguments (none).
     * @param ___ - GraphQL context (unused at this level).
     * @returns Array of catalog descriptors.
     */
    // Listage de tous les catalogues disponibles
    getCatalogs: (_: unknown, __: Record<string, never>, ___: GraphQLContext): CatalogEntry[] => {
      return databaseManager.getAvailableCatalogs().map((id) => ({
        id,
        defaultSchema: databaseManager.getDefaultSchema(id),
        // Source objects carry catalogId so CatalogSchemaInfo's field
        // resolvers can scope their DataLoader keys to the right schema.
        schemas: databaseManager.getSchemas(id).map((name) => ({ catalogId: id, name })),
      }));
    },

    /**
     * Fetches the schema (field list) of a specific catalog/schema.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param args - Catalog alias and optional schema to query.
     * @param context - GraphQL context with loaders.
     * @returns Array of catalog metadata rows describing the schema.
     */
    // Récupération du schéma d'un catalogue spécifique
    getCatalogSchema: async (
      _: unknown,
      { catalog, schema }: CatalogSchemaArgs,
      { loaders }: GraphQLContext,
    ): Promise<CatalogMetadataRow[]> => {
      const targetCatalog = databaseManager.validateCatalogRouting(catalog);
      validateSchemaForCatalog(targetCatalog, schema);
      return loaders.catalogMetadata.load({ catalog: targetCatalog, schema });
    },

    /**
     * Returns field names as {value, label} options for select menus.
     *
     * Reuses the catalogMetadata DataLoader (same Redis cache as
     * getCatalogSchema) and applies all filters in memory. Each filter
     * is optional; when several are provided they are combined with AND.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param args - Filtering options: catalog, schema, sqlType, isCategorical, isPrimaryKey, namePattern.
     * @param context - GraphQL context with loaders.
     * @returns Array of SelectOption where value is the field name and label is the field label (fallback: name).
     */
    // Récupération des noms de champs au format SelectOption avec filtrage en mémoire
    getFields: async (
      _: unknown,
      { catalog, schema, sqlType, isCategorical, isPrimaryKey, namePattern }: FieldsArgs,
      { loaders }: GraphQLContext,
    ): Promise<SelectOption[]> => {
      const targetCatalog = databaseManager.validateCatalogRouting(catalog ?? null);
      validateSchemaForCatalog(targetCatalog, schema);
      const fields = await loaders.catalogMetadata.load({ catalog: targetCatalog, schema });

      // Normalisation des termes de comparaison une seule fois
      const normalizedSqlType = sqlType ? sqlType.toLowerCase() : null;
      const normalizedPattern = namePattern ? namePattern.toLowerCase() : null;

      return fields
        .filter((field) => {
          // Filtre par type SQL (comparaison insensible à la casse)
          if (
            normalizedSqlType &&
            String(field.sql_type ?? '').toLowerCase() !== normalizedSqlType
          ) {
            return false;
          }
          // Filtre par caractère catégoriel
          if (
            typeof isCategorical === 'boolean' &&
            Boolean(field.is_categorical) !== isCategorical
          ) {
            return false;
          }
          // Filtre par caractère clé primaire
          if (typeof isPrimaryKey === 'boolean' && Boolean(field.is_primary_key) !== isPrimaryKey) {
            return false;
          }
          // Filtre par sous-chaîne dans le nom (insensible à la casse)
          if (normalizedPattern && !String(field.name).toLowerCase().includes(normalizedPattern)) {
            return false;
          }
          return true;
        })
        .map((field) => ({
          value: String(field.name),
          // Repli sur le nom lorsque le label est absent ou vide
          label: (field.label as string | undefined) || String(field.name),
        }));
    },

    /**
     * Finds dimension names that are shared across all specified targets.
     *
     * Each target is a (catalog, schema) pair; schema is optional and
     * defaults to the catalog's default schema. Catalogs and schemas
     * are validated against the allow-list before loading. The result
     * is the intersection of dimension name sets across all targets.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param args - List of (catalog, schema) targets.
     * @param context - GraphQL context with loaders.
     * @returns Array of dimension names present in every specified target.
     * @throws {GraphQLError} When targets is empty or contains invalid identifiers.
     */
    // Calcul de l'intersection des dimensions partagées entre plusieurs cibles
    getSharedDimensions: async (
      _: unknown,
      { targets }: SharedDimensionsArgs,
      { loaders }: GraphQLContext,
    ): Promise<string[]> => {
      // Validation de la présence d'au moins une cible
      if (!targets || targets.length === 0) {
        throw new GraphQLError('At least one target must be specified');
      }

      // Validation de chaque cible : catalogue connu et schéma (si fourni) dans l'allow-list
      targets.forEach(({ catalog, schema }) => {
        if (!databaseManager.isValidCatalog(catalog)) {
          throw new GraphQLError(
            `Catalog '${catalog}' is not available. Available: ${databaseManager.getAvailableCatalogs().join(', ')}`,
          );
        }
        validateSchemaForCatalog(catalog, schema);
      });

      const dimensionSets = await Promise.all(
        targets.map(({ catalog, schema }) =>
          loaders.catalogDimensionNames.load({ catalog, schema: schema ?? null }),
        ),
      );

      // Intersection des ensembles de dimensions
      const [first, ...rest] = dimensionSets;
      return first.filter((dim) => rest.every((set) => set.includes(dim)));
    },
  },
};

export { catalogResolvers };
