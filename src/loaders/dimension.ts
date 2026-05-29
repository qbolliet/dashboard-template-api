// Importation des modules
import { BaseQueryLoader } from './base-loader.js';
import { config } from '../utils/config-loader.js';
import type { DuckDBConnection } from './base-loader.js';

// ─── Interfaces de dimension ──────────────────────────────────────────────────

/** Row of a dimension table (minimum value and label columns). */
interface DimensionRecord {
  value: unknown;
  label: unknown;
  [key: string]: unknown;
}

/** Resolved dimension value with its label. */
interface DimensionValue {
  name: string;
  value: unknown;
  label: unknown;
}

/** Parameters for a value lookup in a dimension table. */
interface DimensionValueParams {
  dimensionName: string;
  value: unknown;
}

// Classe de chargement des tables de dimension
/**
 * Loader for dimension table queries.
 *
 * Provides loading of entire dimension tables (for filter dropdowns) and
 * resolution of individual values to their labels (for fact enrichment).
 */
class DimensionLoader extends BaseQueryLoader {
  // Initialisation avec la configuration spécifique aux dimensions
  /**
   * Creates a DimensionLoader bound to a specific database.
   *
   * @param catalogId - Catalog alias to query; null uses the default catalog.
   * @param schema - DuckLake schema within the catalog; null uses the catalog default.
   */
  constructor(catalogId: string | null = null, schema: string | null = null) {
    super({
      batchSize: config.API.LOADERS.BATCH_SIZE,
      cachePrefix: 'dimension',
      cache: true,
      // Durée de mise en cache plus longue car les dimensions changent rarement
      cacheTimeout: config.API.LOADERS.DIMENSION_CACHE_TIMEOUT,
      catalogId,
      schema,
    });
  }

  // Méthode de chargement d'une seule table de dimension
  /**
   * Loads all rows from a single dimension table.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param name - Dimension name (table looked up as dim_{name}).
   * @returns Array of dimension records, or empty array on error.
   */
  async loadSingle(connection: DuckDBConnection, name: string): Promise<DimensionRecord[]> {
    try {
      // Construction de la requête de la table de dimensions
      const query = `SELECT * FROM ${this.qualifyTable(`dim_${name}`)}`;

      // Exécution de la requête
      const results = await connection.all(query);

      return (results as DimensionRecord[]) || [];
    } catch {
      // Tableau vide en cas d'erreur (dimension inexistante, etc.)
      return [];
    }
  }

  // Méthode de chargement du label associé à une seule valeur
  /**
   * Loads a single dimension value with its associated label.
   *
   * Falls back to the raw value as label when the value is not found
   * in the dimension table or when the query fails.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param params - Object with dimensionName and value to look up.
   * @returns DimensionValue with name, value and resolved label.
   */
  async loadSingleValue(
    connection: DuckDBConnection,
    { dimensionName, value }: DimensionValueParams,
  ): Promise<DimensionValue> {
    try {
      const query = `SELECT value, label FROM ${this.qualifyTable(`dim_${dimensionName}`)} WHERE value = ?`;
      const results = await connection.all(query, [value]);

      if (results && results.length > 0) {
        return {
          name: dimensionName,
          value: results[0].value,
          label: results[0].label,
        };
      }

      // Valeur brute utilisée comme label quand non trouvée dans la dimension
      return { name: dimensionName, value, label: value };
    } catch {
      // En cas d'erreur, retour de la valeur brute
      return { name: dimensionName, value, label: value };
    }
  }

  // Méthode de chargement batch des valeurs de dimension en une seule requête par dimension
  /**
   * Loads multiple dimension values in a single query per dimension.
   *
   * Groups params by dimensionName and issues one IN-query per group,
   * running all groups in parallel. Returns results in the same order
   * as the input params array.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param params - Array of {dimensionName, value} lookup requests.
   * @returns Array of DimensionValue, aligned with input params order.
   */
  async loadBatchValues(
    connection: DuckDBConnection,
    params: readonly DimensionValueParams[],
  ): Promise<(DimensionValue | null)[]> {
    // Regroupement des paramètres par dimension pour optimiser les requêtes
    const groupedParams = params.reduce<Record<string, unknown[]>>((acc, param) => {
      if (!acc[param.dimensionName]) acc[param.dimensionName] = [];
      acc[param.dimensionName].push(param.value);
      return acc;
    }, {});

    // Index global Map<dimensionName, Map<value, result>> pour lookup O(1) au retour
    const allResults = new Map<string, Map<unknown, DimensionValue>>();

    // Requêtes en parallèle pour toutes les dimensions
    await Promise.all(
      Object.entries(groupedParams).map(async ([dimensionName, values]) => {
        const dimMap = new Map<unknown, DimensionValue>();
        allResults.set(dimensionName, dimMap);
        try {
          const placeholders = values.map(() => '?').join(',');
          const query = `SELECT value, label FROM ${this.qualifyTable(`dim_${dimensionName}`)} WHERE value IN (${placeholders})`;
          const dimensionResults = await connection.all(query, values);
          if (dimensionResults) {
            dimensionResults.forEach((row) => {
              dimMap.set(row.value, {
                name: dimensionName,
                value: row.value,
                label: row.label,
              });
            });
          }
        } catch {
          // En cas d'erreur, les valeurs brutes seront retournées par défaut ci-dessous
        }
      }),
    );

    // Retour des résultats dans l'ordre des paramètres originaux — O(1) par lookup
    return params.map((param) => {
      const found = allResults.get(param.dimensionName)?.get(param.value);
      return found ?? { name: param.dimensionName, value: param.value, label: param.value };
    });
  }
}

// Fonction de création d'un loader pour les tables de dimension entières
/**
 * Creates a DataLoader for loading complete dimension tables.
 *
 * @param catalogId - Catalog alias to query; null uses the default catalog.
 * @param schema - DuckLake schema within the catalog; null uses the catalog default.
 * @returns DataLoader keyed by dimension name, returning arrays of DimensionRecord.
 */
const createDimensionLoader = (catalogId: string | null = null, schema: string | null = null) => {
  const loader = new DimensionLoader(catalogId, schema);
  return loader.createLoader<string, DimensionRecord[]>((connection, name) =>
    loader.loadSingle(connection, name),
  );
};

// Fonction de création d'un loader pour la résolution de labels de valeurs de dimension
/**
 * Creates a DataLoader for resolving individual dimension values to labels.
 *
 * Optimized for batch operations: groups keys by dimension and issues one
 * IN-query per group, significantly reducing database round-trips when
 * enriching multiple fact rows.
 *
 * @param catalogId - Catalog alias to query; null uses the default catalog.
 * @param schema - DuckLake schema within the catalog; null uses the catalog default.
 * @returns DataLoader keyed by DimensionValueParams, returning DimensionValue.
 */
const createDimensionValueLoader = (
  catalogId: string | null = null,
  schema: string | null = null,
) => {
  const loader = new DimensionLoader(catalogId, schema);
  return loader.createBatchLoader<DimensionValueParams, DimensionValue>(
    (connection, params) => loader.loadBatchValues(connection, params),
    {
      cacheKeyFn: ({ dimensionName, value }: DimensionValueParams) => `${dimensionName}:${value}`,
      // Taille de batch augmentée pour amortir les requêtes de résolution de labels
      maxBatchSize: config.API.LOADERS.MAX_BATCH_SIZE,
    },
  );
};

export { createDimensionLoader, createDimensionValueLoader };
export type { DimensionRecord, DimensionValue, DimensionValueParams };
