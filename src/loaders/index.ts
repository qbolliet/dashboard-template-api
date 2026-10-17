// Importation des modules de création de loaders
import { createMetadataLoader } from './metadata.js';
import {
  createFactLoader,
  createFactWithCountLoader,
  createFactWithMetadataLoader,
} from './fact.js';
import { createSelectOptionsLoader, createSelectOptionsTreeLoader } from './select-options.js';
import { createFieldStatsLoader } from './field-stats.js';
import { createAggregatesLoader, createAggregateGroupCountLoader } from './aggregates.js';
import { createCatalogMetadataLoader } from './catalog.js';
import { createDatasetInfoLoader } from './dataset-info.js';
import {
  createCompareFacts,
  createCompareAggregatedFacts,
  createCrossDatabaseSelectOptions,
} from './cross-database.js';
import { databaseManager } from '../db/index.js';

import type { FieldMetadata } from '../utils/metadata-mapping.js';
import type { FactQueryParams, FactQueryResult } from './fact.js';
import type {
  SelectOptionsParams,
  SelectOption,
  SelectOptionsTreeParams,
  SelectOptionNode,
} from './select-options.js';
import type { FieldStatsParams, FieldStats } from './field-stats.js';
import type { AggregatePage } from './aggregates.js';
import type { AggregatePageParams, AggregateCountParams } from '../utils/aggregate-query.js';
import type { CatalogSchemaKey } from './catalog.js';
import type { DatasetInfo } from './dataset-info.js';
import type {
  CompareFactsParams,
  CompareAggregatedFactsParams,
  CrossDatabaseSelectOptionsParams,
  ComparisonResult,
  AggregateComparisonPage,
  CrossDatabaseSelectOption,
} from './cross-database.js';
import type DataLoader from 'dataloader';
/** DataLoader alias with a string cache key, used by all loaders in this module. */
export type Loader<K, V> = DataLoader<K, V, string>;

// ─── Interface de la collection de loaders ───────────────────────────────────

/** Complete collection of loaders available for a single GraphQL request. */
interface LoadersCollection {
  metadata: Loader<string, FieldMetadata | null>;
  fact: Loader<FactQueryParams, FactQueryResult>;
  factWithCount: Loader<FactQueryParams, FactQueryResult>;
  factWithMetadata: Loader<FactQueryParams, FactQueryResult>;
  aggregates: Loader<AggregatePageParams, AggregatePage>;
  aggregateGroupCount: Loader<AggregateCountParams, number>;
  selectOptions: Loader<SelectOptionsParams, SelectOption[]>;
  selectOptionsTree: Loader<SelectOptionsTreeParams, SelectOptionNode[]>;
  fieldStats: Loader<FieldStatsParams, FieldStats>;
  catalogMetadata: Loader<CatalogSchemaKey, FieldMetadata[]>;
  datasetInfo: Loader<CatalogSchemaKey, DatasetInfo>;
  compareFacts: Loader<CompareFactsParams, ComparisonResult>;
  compareAggregatedFacts: Loader<CompareAggregatedFactsParams, AggregateComparisonPage>;
  crossDatabaseSelectOptions: Loader<CrossDatabaseSelectOptionsParams, CrossDatabaseSelectOption[]>;
}

// Fonction de création de l'ensemble des loaders pour un identifiant de base de données
/**
 * Creates and initializes all data loaders for a given database.
 *
 * Instantiates one DataLoader per query type. Catalog and cross-database
 * loaders are shared and independent of catalogId.
 *
 * @param catalogId - Catalog alias to use for all single-catalog loaders.
 *   Null uses the configured default catalog.
 * @param schema - DuckLake schema within the catalog. Null uses the catalog's
 *   configured default schema. Validated against the catalog's allow-list
 *   (anti-injection: the schema is interpolated into qualified table names).
 * @returns LoadersCollection with all the loaders of one request.
 */
const createLoaders = (
  catalogId: string | null = null,
  schema: string | null = null,
): LoadersCollection => {
  // Validation du schéma contre l'allow-list du catalogue cible (le schéma
  // sera interpolé dans le SQL via qualifyTable, donc jamais une chaîne libre).
  if (schema) {
    const targetCatalog = catalogId ?? databaseManager.getDefaultCatalog();
    if (!databaseManager.isValidSchema(targetCatalog, schema)) {
      throw new Error(
        `Schema '${schema}' is not available for catalog '${targetCatalog}'. ` +
          `Available: ${databaseManager.getSchemas(targetCatalog).join(', ')}`,
      );
    }
  }

  // Loader des méta-données de colonnes
  const metadataLoader = createMetadataLoader(catalogId, schema);

  // Loaders pour les faits
  const factLoader = createFactLoader(catalogId, schema);
  const factWithCountLoader = createFactWithCountLoader(catalogId, schema);
  const factWithMetadataLoader = createFactWithMetadataLoader(catalogId, schema);

  // Loaders des agrégats : pages, et comptage des groupes en cache séparé
  const aggregatesLoader = createAggregatesLoader(catalogId, schema);
  const aggregateGroupCountLoader = createAggregateGroupCountLoader(catalogId, schema);

  const selectOptionsLoader = createSelectOptionsLoader(catalogId, schema);
  const selectOptionsTreeLoader = createSelectOptionsTreeLoader(catalogId, schema);
  const fieldStatsLoader = createFieldStatsLoader(catalogId, schema);

  // Loaders catalog et cross-database — partagés, indépendants du catalogId
  const catalogMetadataLoader = createCatalogMetadataLoader();
  const datasetInfoLoader = createDatasetInfoLoader();
  const compareFactsLoader = createCompareFacts();
  const compareAggregatedFactsLoader = createCompareAggregatedFacts();
  const crossDatabaseSelectOptionsLoader = createCrossDatabaseSelectOptions();

  // Retourne un objet avec l'ensemble des loaders et les méthodes utilitaires
  return {
    metadata: metadataLoader,
    fact: factLoader,
    factWithCount: factWithCountLoader,
    factWithMetadata: factWithMetadataLoader,
    aggregates: aggregatesLoader,
    aggregateGroupCount: aggregateGroupCountLoader,
    selectOptions: selectOptionsLoader,
    selectOptionsTree: selectOptionsTreeLoader,
    fieldStats: fieldStatsLoader,
    catalogMetadata: catalogMetadataLoader,
    datasetInfo: datasetInfoLoader,
    compareFacts: compareFactsLoader,
    compareAggregatedFacts: compareAggregatedFactsLoader,
    crossDatabaseSelectOptions: crossDatabaseSelectOptionsLoader,
  };
};

export { createLoaders };
export type { LoadersCollection };
