// Importation des modules
import { GraphQLError } from 'graphql';
import { databaseManager } from '../../db/index.js';
import type { GraphQLContext } from './types.js';
import type { CatalogMetadataRow } from '../../loaders/catalog.js';
import type { SelectOption } from '../../loaders/select-options.js';

// ─── Interfaces des arguments ─────────────────────────────────────────────────

/** Arguments for the getDatabaseSchema query. */
export interface DatabaseSchemaArgs {
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

/** Arguments for the getSharedDimensions query. */
export interface SharedDimensionsArgs {
  catalogs: string[];
  schemas?: (string | null)[];
}

// ─── Interfaces des résultats ─────────────────────────────────────────────────

/** Catalog entry for a catalog, containing its schemas, fields and dimension names. */
export interface DatabaseCatalogEntry {
  id: string;
  schemas: string[];
  fields: CatalogMetadataRow[];
  dimensionNames: string[];
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
 * Resolvers for catalog queries.
 *
 * Exposes the list of available catalogs, their schemas, and shared
 * dimensions across multiple catalogs for cross-catalog analysis.
 */
const catalogResolvers = {
  Query: {
    /**
     * Lists all available catalogs with their (default-schema) fields and dimension names.
     *
     * Loads catalog metadata and dimension names for each catalog in
     * parallel, using empty arrays as graceful fallbacks on error.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param __ - Query arguments (none).
     * @param context - GraphQL context with loaders.
     * @returns Array of catalog catalog entries.
     */
    // Listage de tous les catalogues disponibles avec leur schéma par défaut
    getDatabases: async (
      _: unknown,
      __: Record<string, never>,
      { loaders }: GraphQLContext,
    ): Promise<DatabaseCatalogEntry[]> => {
      const catalogs = databaseManager.getAvailableCatalogs();

      return Promise.all(
        catalogs.map(async (id) => {
          let fields: CatalogMetadataRow[];
          let dimensionNames: string[];

          // Chargement du schéma avec fallback sur tableau vide en cas d'erreur
          try {
            fields = await loaders.catalogMetadata.load({ catalog: id });
          } catch {
            fields = [];
          }

          // Chargement des noms de dimensions avec fallback sur tableau vide
          try {
            dimensionNames = await loaders.catalogDimensionNames.load({ catalog: id });
          } catch {
            dimensionNames = [];
          }

          return {
            id,
            schemas: databaseManager.getSchemas(id),
            fields: fields ?? [],
            dimensionNames: dimensionNames ?? [],
          };
        }),
      );
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
    getDatabaseSchema: async (
      _: unknown,
      { catalog, schema }: DatabaseSchemaArgs,
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
     * getDatabaseSchema) and applies all filters in memory. Each filter
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
     * Finds dimension names that are shared across all specified catalogs.
     *
     * Validates each catalog alias before loading, then intersects the
     * dimension name sets to return only the common dimensions. Schemas can
     * be supplied per catalog (aligned by index) to compare specific schemas.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param args - List of catalog aliases and optional aligned schemas.
     * @param context - GraphQL context with loaders.
     * @returns Array of dimension names present in every specified catalog.
     * @throws {GraphQLError} When catalogs is empty or contains invalid aliases.
     */
    // Calcul de l'intersection des dimensions partagées entre plusieurs catalogues
    getSharedDimensions: async (
      _: unknown,
      { catalogs, schemas }: SharedDimensionsArgs,
      { loaders }: GraphQLContext,
    ): Promise<string[]> => {
      // Validation de la présence d'au moins un catalogue
      if (!catalogs || catalogs.length === 0) {
        throw new GraphQLError('At least one catalog must be specified');
      }

      // Validation de chaque identifiant de catalogue
      catalogs.forEach((cat) => {
        if (!databaseManager.isValidCatalog(cat)) {
          throw new GraphQLError(
            `Catalog '${cat}' is not available. Available: ${databaseManager.getAvailableCatalogs().join(', ')}`,
          );
        }
      });

      // Validation des schémas fournis : chaque schéma doit appartenir à
      // l'allow-list du catalogue auquel il est aligné par index.
      schemas?.forEach((s, i) => validateSchemaForCatalog(catalogs[i], s));

      const dimensionSets = await Promise.all(
        catalogs.map((cat, i) =>
          loaders.catalogDimensionNames.load({ catalog: cat, schema: schemas?.[i] ?? null }),
        ),
      );

      if (dimensionSets.length === 0) return [];

      // Intersection des ensembles de dimensions
      const [first, ...rest] = dimensionSets;
      return first.filter((dim) => rest.every((set) => set.includes(dim)));
    },
  },
};

export { catalogResolvers };
