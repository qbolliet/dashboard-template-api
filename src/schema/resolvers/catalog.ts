// Importation des modules
import { GraphQLError } from 'graphql';
import { databaseManager } from '../../db/index.js';
import type { GraphQLContext } from './types.js';
import type { CatalogMetadataRow } from '../../loaders/catalog.js';
import type { SelectOption } from '../../loaders/select-options.js';

// ─── Interfaces des arguments ─────────────────────────────────────────────────

/** Arguments for the getDatabaseSchema query. */
export interface DatabaseSchemaArgs {
  database: string;
}

/** Arguments for the getFields query. */
export interface FieldsArgs {
  database?: string | null;
  sqlType?: string | null;
  isCategorical?: boolean | null;
  isPrimaryKey?: boolean | null;
  namePattern?: string | null;
}

/** Arguments for the getSharedDimensions query. */
export interface SharedDimensionsArgs {
  databases: string[];
}

// ─── Interfaces des résultats ─────────────────────────────────────────────────

/** Catalog entry for a database, containing its schema and dimension names. */
export interface DatabaseCatalogEntry {
  id: string;
  fields: CatalogMetadataRow[];
  dimensionNames: string[];
}

// Construction d'un resolver pour le catalogue multi-bases
/**
 * Resolvers for database catalog queries.
 *
 * Exposes the list of available databases, their schemas, and shared
 * dimensions across multiple databases for cross-database analysis.
 */
const catalogResolvers = {
  Query: {
    /**
     * Lists all available databases with their schemas and dimension names.
     *
     * Loads catalog metadata and dimension names for each database in
     * parallel, using empty arrays as graceful fallbacks on error.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param __ - Query arguments (none).
     * @param context - GraphQL context with loaders.
     * @returns Array of database catalog entries.
     */
    // Listage de toutes les bases de données disponibles avec leur schéma
    getDatabases: async (
      _: unknown,
      __: Record<string, never>,
      { loaders }: GraphQLContext,
    ): Promise<DatabaseCatalogEntry[]> => {
      const databases = databaseManager.getAvailableDatabases() as string[];

      return Promise.all(
        databases.map(async (id) => {
          let fields: CatalogMetadataRow[];
          let dimensionNames: string[];

          // Chargement du schéma avec fallback sur tableau vide en cas d'erreur
          try {
            fields = await loaders.catalogMetadata.load(id);
          } catch {
            fields = [];
          }

          // Chargement des noms de dimensions avec fallback sur tableau vide
          try {
            dimensionNames = await loaders.catalogDimensionNames.load(id);
          } catch {
            dimensionNames = [];
          }

          return { id, fields: fields ?? [], dimensionNames: dimensionNames ?? [] };
        }),
      );
    },

    /**
     * Fetches the schema (field list) of a specific database.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param database - Database alias to query.
     * @param context - GraphQL context with loaders.
     * @returns Array of catalog metadata rows describing the database schema.
     */
    // Récupération du schéma d'une base de données spécifique
    getDatabaseSchema: async (
      _: unknown,
      { database }: DatabaseSchemaArgs,
      { loaders }: GraphQLContext,
    ): Promise<CatalogMetadataRow[]> => {
      const targetDb = databaseManager.validateDatabaseRouting(database) as string;
      return loaders.catalogMetadata.load(targetDb);
    },

    /**
     * Returns field names as {value, label} options for select menus.
     *
     * Reuses the catalogMetadata DataLoader (same Redis cache as
     * getDatabaseSchema) and applies all filters in memory. Each filter
     * is optional; when several are provided they are combined with AND.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param args - Filtering options: database, sqlType, isCategorical, isPrimaryKey, namePattern.
     * @param context - GraphQL context with loaders.
     * @returns Array of SelectOption where value is the field name and label is the field label (fallback: name).
     */
    // Récupération des noms de champs au format SelectOption avec filtrage en mémoire
    getFields: async (
      _: unknown,
      { database, sqlType, isCategorical, isPrimaryKey, namePattern }: FieldsArgs,
      { loaders }: GraphQLContext,
    ): Promise<SelectOption[]> => {
      const targetDb = databaseManager.validateDatabaseRouting(database ?? null) as string;
      const fields = await loaders.catalogMetadata.load(targetDb);

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
     * Finds dimension names that are shared across all specified databases.
     *
     * Validates each database alias before loading, then intersects the
     * dimension name sets to return only the common dimensions.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param databases - List of database aliases to compare.
     * @param context - GraphQL context with loaders.
     * @returns Array of dimension names present in every specified database.
     * @throws {GraphQLError} When databases is empty or contains invalid aliases.
     */
    // Calcul de l'intersection des dimensions partagées entre plusieurs bases
    getSharedDimensions: async (
      _: unknown,
      { databases }: SharedDimensionsArgs,
      { loaders }: GraphQLContext,
    ): Promise<string[]> => {
      // Validation de la présence d'au moins une base de données
      if (!databases || databases.length === 0) {
        throw new GraphQLError('At least one database must be specified');
      }

      // Validation de chaque identifiant de base de données
      databases.forEach((db) => {
        if (!databaseManager.isValidDatabase(db)) {
          throw new GraphQLError(
            `Database '${db}' is not available. Available: ${(databaseManager.getAvailableDatabases() as string[]).join(', ')}`,
          );
        }
      });

      const dimensionSets = await Promise.all(
        databases.map((db) => loaders.catalogDimensionNames.load(db)),
      );

      if (dimensionSets.length === 0) return [];

      // Intersection des ensembles de dimensions
      const [first, ...rest] = dimensionSets;
      return first.filter((dim) => rest.every((set) => set.includes(dim)));
    },
  },
};

export { catalogResolvers };
