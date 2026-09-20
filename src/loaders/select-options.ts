// Importation des modules
import { GraphQLError } from 'graphql';
import { BaseQueryLoader } from './base-loader.js';
import { config } from '../utils/config-loader.js';
import { validateIdentifier } from '../utils/utils.js';
import type { DuckDBConnection } from './base-loader.js';

// ─── Interfaces des options de sélection ─────────────────────────────────────

/** Parameters for a select options query. */
interface SelectOptionsParams {
  fieldName: string;
  limit: number;
  searchTerm?: string | null;
}

/** Select option with value and label. */
interface SelectOption {
  value: string;
  label: string;
}

// ─── Fonction utilitaire ─────────────────────────────────────────────────────

/**
 * Escapes the LIKE wildcards of a user-provided search term.
 *
 * The term is passed as a bound parameter, so this only neutralizes `%`, `_`
 * and the escape character itself, which would otherwise widen the match.
 *
 * @param term - Raw search term.
 * @returns Term safe to wrap in `%…%` for a LIKE … ESCAPE '\' predicate.
 */
// Échappement des jokers LIKE d'un terme de recherche
function escapeLikeWildcards(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// Classe de chargement des options de sélection
/**
 * Loader for select option queries (dropdown values).
 *
 * The fact table stores labels directly (no dim_* table exists), so every
 * field resolves the same way: a DISTINCT scan of the column, with
 * `label = value`.
 */
class SelectOptionsLoader extends BaseQueryLoader {
  // Initialisation avec la configuration spécifique aux options de sélection
  /**
   * Creates a SelectOptionsLoader bound to a specific database.
   *
   * @param catalogId - Catalog alias to query; null uses the default catalog.
   * @param schema - DuckLake schema within the catalog; null uses the catalog default.
   */
  constructor(catalogId: string | null = null, schema: string | null = null) {
    super({
      batchSize: config.API.LOADERS.BATCH_SIZE,
      cachePrefix: 'select-options',
      cache: true,
      // Durée de mise en cache plus longue car les options changent peu
      cacheTimeout: config.API.LOADERS.SELECT_OPTIONS_CACHE_TIMEOUT,
      catalogId,
      schema,
    });
  }

  // Méthode de chargement des valeurs distinctes d'une colonne
  /**
   * Loads the distinct values of a fact table column as select options.
   *
   * NULL values are excluded — they carry no modality and terminate a branch
   * of a column hierarchy. The search term is bound as a parameter and its
   * LIKE wildcards are escaped.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param params - Object with fieldName, limit, and optional searchTerm.
   * @returns Array of SelectOption where value and label are the column value.
   * @throws {GraphQLError} BAD_USER_INPUT when the column does not exist in the
   *   schema's metadata table.
   */
  async loadSelectOptions(
    connection: DuckDBConnection,
    { fieldName, limit, searchTerm }: SelectOptionsParams,
  ): Promise<SelectOption[]> {
    validateIdentifier(fieldName, 'fieldName');

    // La colonne doit être déclarée dans metadata : contrôle explicite pour
    // renvoyer une erreur utilisable plutôt que de laisser fuiter DuckDB.
    const declared = await connection.all(
      `SELECT name FROM ${this.qualifyTable('metadata')} WHERE name = ?`,
      [fieldName],
    );
    if (declared.length === 0) {
      throw new GraphQLError(`Unknown field '${fieldName}'`, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    // Construction de la requête : valeurs distinctes, NULL exclus, triées
    let query =
      `SELECT DISTINCT ${fieldName} AS value FROM ${this.qualifyTable('fact_table')} ` +
      `WHERE ${fieldName} IS NOT NULL`;
    const params: unknown[] = [];

    // Recherche insensible à la casse, jokers du terme neutralisés
    if (searchTerm) {
      query += ` AND LOWER(CAST(${fieldName} AS VARCHAR)) LIKE ? ESCAPE '\\'`;
      params.push(`%${escapeLikeWildcards(searchTerm.toLowerCase())}%`);
    }

    query += ` ORDER BY ${fieldName} LIMIT ?`;
    params.push(limit);

    const results = await connection.all(query, params);

    // La fact table porte le libellé : label = value, toujours (spec bdd §2.4)
    return results.map((row) => ({
      value: String(row.value),
      label: String(row.value),
    }));
  }
}

// Fonction de création d'un loader pour les options de sélection
/**
 * Creates a DataLoader for select option queries.
 *
 * @param catalogId - Catalog alias to query; null uses the default catalog.
 * @param schema - DuckLake schema within the catalog; null uses the catalog default.
 * @returns DataLoader keyed by SelectOptionsParams, returning SelectOption arrays.
 */
const createSelectOptionsLoader = (
  catalogId: string | null = null,
  schema: string | null = null,
) => {
  const loader = new SelectOptionsLoader(catalogId, schema);
  return loader.createLoader<SelectOptionsParams, SelectOption[]>((connection, params) =>
    loader.loadSelectOptions(connection, params),
  );
};

export { createSelectOptionsLoader, SelectOptionsLoader };
export type { SelectOptionsParams, SelectOption };
