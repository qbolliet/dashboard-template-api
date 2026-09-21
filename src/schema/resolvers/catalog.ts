// Importation des modules
import { GraphQLError } from 'graphql';
import { databaseManager } from '../../db/index.js';
import type { GraphQLContext } from './types.js';
import { sqlTypeFamily } from '../../utils/filter-tree.js';
import type { FieldMetadata } from '../../utils/metadata-mapping.js';
import type { DatasetInfo } from '../../loaders/dataset-info.js';
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
  family?: string | null;
}

/** A single (catalog, schema) target as accepted by getSharedFields. */
export interface CatalogSchemaTarget {
  catalog: string;
  schema?: string | null;
}

/** Arguments for the getSharedFields query. */
export interface SharedFieldsArgs {
  targets: CatalogSchemaTarget[];
}

// ─── Interfaces des résultats ─────────────────────────────────────────────────

/**
 * Source object exposed by Catalog.schemas to resolve CatalogSchemaInfo
 * sub-fields. Carries the parent catalog id so that the `fields` field
 * resolver knows which DataLoader key to use.
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

/**
 * Resolves the SQL type family of a metadata row.
 *
 * A column whose SQL type is unknown to the filter compiler yields null: it
 * then only matches another column that is equally unknown, which keeps the
 * intersection conservative instead of silently pairing incompatible columns.
 *
 * @param row - Metadata row of a catalog/schema.
 * @returns The type family, or null when the SQL type is unsupported.
 */
// Famille de type SQL d'une colonne, null si le type n'est pas reconnu
function typeFamilyOf(row: FieldMetadata): string | null {
  try {
    return sqlTypeFamily(row.sqlType);
  } catch {
    return null;
  }
}

// Construction d'un resolver pour le catalogue multi-bases
/**
 * Resolvers for catalog introspection queries.
 *
 * Exposes the list of available catalogs and their schemas (with lazy
 * per-schema fields via the CatalogSchemaInfo type resolver), the field
 * metadata of a specific (catalog, schema) pair, a filtered SelectOption
 * view of those fields, and the intersection of fields across several
 * (catalog, schema) targets.
 */
const catalogResolvers = {
  // ── Type resolver: per-schema lazy loading of the field metadata ──
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
    ): Promise<FieldMetadata[]> => {
      return loaders.catalogMetadata.load({ catalog: parent.catalogId, schema: parent.name });
    },

    /**
     * Loads the dataset_metadata row of the schema this source describes.
     *
     * Same lazy mechanism as `fields`: a query that only asks for
     * `schemas { name }` never touches the dataset_metadata table.
     *
     * @param parent - Source object {catalogId, name} carried from Catalog.schemas.
     * @param _ - Field arguments (none).
     * @param context - GraphQL context with loaders.
     * @returns Dataset information of this schema.
     */
    info: async (
      parent: CatalogSchemaInfoSource,
      _: Record<string, never>,
      { loaders }: GraphQLContext,
    ): Promise<DatasetInfo> => {
      return loaders.datasetInfo.load({ catalog: parent.catalogId, schema: parent.name });
    },
  },

  Query: {
    /**
     * Lists all available catalogs with their hosted schemas.
     *
     * Returns catalog identifiers and per-schema sources usable by the
     * CatalogSchemaInfo type resolvers. The `fields` sub-field of each
     * schema is loaded only when explicitly selected by the client
     * (lazy cascade via GraphQL selection sets).
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
    ): Promise<FieldMetadata[]> => {
      const targetCatalog = databaseManager.validateCatalogRouting(catalog);
      validateSchemaForCatalog(targetCatalog, schema);
      return loaders.catalogMetadata.load({ catalog: targetCatalog, schema });
    },

    /**
     * Fetches the dataset information of a specific catalog/schema.
     *
     * Same data as the lazy `info` field of CatalogSchemaInfo, addressable
     * directly when the client already knows which schema it wants.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param args - Catalog alias and optional schema to query.
     * @param context - GraphQL context with loaders.
     * @returns Dataset information of the target schema.
     */
    // Récupération des méta-données de jeu de résultats d'un catalogue/schéma
    getDatasetInfo: async (
      _: unknown,
      { catalog, schema }: CatalogSchemaArgs,
      { loaders }: GraphQLContext,
    ): Promise<DatasetInfo> => {
      const targetCatalog = databaseManager.validateCatalogRouting(catalog);
      validateSchemaForCatalog(targetCatalog, schema);
      return loaders.datasetInfo.load({ catalog: targetCatalog, schema });
    },

    /**
     * Returns field names as {value, label} options for select menus.
     *
     * Reuses the catalogMetadata DataLoader (same Redis cache as
     * getCatalogSchema) and applies all filters in memory. Each filter
     * is optional; when several are provided they are combined with AND.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param args - Filtering options: catalog, schema, sqlType, isCategorical, isPrimaryKey, namePattern, family.
     * @param context - GraphQL context with loaders.
     * @returns Array of SelectOption where value is the field name and label is the field label (fallback: name).
     */
    // Récupération des noms de champs au format SelectOption avec filtrage en mémoire
    getFields: async (
      _: unknown,
      { catalog, schema, sqlType, isCategorical, isPrimaryKey, namePattern, family }: FieldsArgs,
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
          if (normalizedSqlType && field.sqlType.toLowerCase() !== normalizedSqlType) {
            return false;
          }
          // Filtre par caractère catégoriel
          if (typeof isCategorical === 'boolean' && field.isCategorical !== isCategorical) {
            return false;
          }
          // Filtre par caractère clé primaire
          if (typeof isPrimaryKey === 'boolean' && field.isPrimaryKey !== isPrimaryKey) {
            return false;
          }
          // Filtre par famille thématique (égalité stricte, colonne metadata.family)
          if (family && field.family !== family) {
            return false;
          }
          // Filtre par sous-chaîne dans le nom (insensible à la casse)
          if (normalizedPattern && !String(field.name).toLowerCase().includes(normalizedPattern)) {
            return false;
          }
          return true;
        })
        .map((field) => ({
          value: field.name,
          // Repli sur le nom lorsque le label est vide
          label: field.label || field.name,
        }));
    },

    /**
     * Finds the categorical field names shared by all specified targets.
     *
     * Each target is a (catalog, schema) pair; schema is optional and
     * defaults to the catalog's default schema. Catalogs and schemas are
     * validated against the allow-list before loading. A field is shared
     * when every target declares it as categorical under the same name and
     * with the same SQL type family, so it is safe to use as a join key in
     * a cross-catalog query.
     *
     * @param _ - Parent resolver result (unused at root).
     * @param args - List of (catalog, schema) targets.
     * @param context - GraphQL context with loaders.
     * @returns Array of field names present in every specified target.
     * @throws {GraphQLError} When targets is empty or contains invalid identifiers.
     */
    // Intersection des metadata des cibles : même nom, même famille de type
    getSharedFields: async (
      _: unknown,
      { targets }: SharedFieldsArgs,
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

      const metadataSets = await Promise.all(
        targets.map(({ catalog, schema }) =>
          loaders.catalogMetadata.load({ catalog, schema: schema ?? null }),
        ),
      );

      // Indexation par nom de colonne catégorielle, avec sa famille de type
      const indexed = metadataSets.map((rows) => {
        const families = new Map<string, string | null>();
        rows
          .filter((row) => row.isCategorical)
          .forEach((row) => families.set(String(row.name), typeFamilyOf(row)));
        return families;
      });

      const [first, ...rest] = indexed;
      return [...first.entries()]
        .filter(([name, family]) =>
          rest.every((other) => other.has(name) && other.get(name) === family),
        )
        .map(([name]) => name);
    },
  },
};

export { catalogResolvers };
