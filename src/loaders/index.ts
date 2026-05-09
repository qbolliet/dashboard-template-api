// Importation des modules de création de loaders
import { createMetadataLoader } from './metadata.js';
import { createDimensionLoader, createDimensionValueLoader } from './dimension.js';
import {
    createFactLoader,
    createFactWithCountLoader,
    createFactWithMetadataLoader
} from './fact.js';
import { createSelectOptionsLoader } from './select-options.js';
import {
    createAggregatedFactsLoader,
    createAggregatedFactsWithMetadataLoader,
    createAggregatedFactsWithCountLoader
} from './aggregated-facts.js';
import { createCatalogMetadataLoader, createCatalogDimensionNamesLoader } from './catalog.js';
import {
    createCompareFacts,
    createCompareAggregatedFacts,
    createCrossDatabaseSelectOptions
} from './cross-database.js';

import type { MetadataRow } from './metadata.js';
import type { DimensionRecord, DimensionValue, DimensionValueParams } from './dimension.js';
import type { FactQueryParams, FactQueryResult } from './fact.js';
import type { SelectOptionsParams, SelectOption } from './select-options.js';
import type { AggregatedQueryParams, AggregatedResult } from './aggregated-facts.js';
import type { CatalogMetadataRow } from './catalog.js';
import type {
    CompareFactsParams,
    CompareAggregatedFactsParams,
    CrossDatabaseSelectOptionsParams,
    ComparisonResult,
    CrossDatabaseSelectOption
} from './cross-database.js';
import type DataLoader from 'dataloader';
/** DataLoader alias with a string cache key, used by all loaders in this module. */
export type Loader<K, V> = DataLoader<K, V, string>;

// ─── Interfaces des données d'amorçage ───────────────────────────────────────

/** Generic key/value pair for priming a DataLoader. */
interface KeyValuePair<K, V> {
    key: K;
    value: V;
}

/** Optional initial data for priming the full set of loaders. */
interface PrimeData {
    metadata?: KeyValuePair<string, MetadataRow | null>[];
    dimensions?: KeyValuePair<string, DimensionRecord[]>[];
    dimensionValues?: KeyValuePair<DimensionValueParams, DimensionValue>[];
    facts?: KeyValuePair<FactQueryParams, FactQueryResult>[];
    factsWithCount?: KeyValuePair<FactQueryParams, FactQueryResult>[];
    factsWithMetadata?: KeyValuePair<FactQueryParams, FactQueryResult>[];
    aggregatedFacts?: KeyValuePair<AggregatedQueryParams, AggregatedResult>[];
    aggregatedFactsWithMetadata?: KeyValuePair<AggregatedQueryParams, AggregatedResult>[];
    aggregatedFactsWithCount?: KeyValuePair<AggregatedQueryParams, AggregatedResult>[];
    selectOptions?: KeyValuePair<SelectOptionsParams, SelectOption[]>[];
}

// ─── Interface de la collection de loaders ───────────────────────────────────

/** Complete collection of loaders available for a single GraphQL request. */
interface LoadersCollection {
    metadata: Loader<string, MetadataRow | null>;
    dimension: Loader<string, DimensionRecord[]>;
    dimensionValue: Loader<DimensionValueParams, DimensionValue>;
    fact: Loader<FactQueryParams, FactQueryResult>;
    factWithCount: Loader<FactQueryParams, FactQueryResult>;
    factWithMetadata: Loader<FactQueryParams, FactQueryResult>;
    aggregatedFacts: Loader<AggregatedQueryParams, AggregatedResult>;
    aggregatedFactsWithMetadata: Loader<AggregatedQueryParams, AggregatedResult>;
    aggregatedFactsWithCount: Loader<AggregatedQueryParams, AggregatedResult>;
    selectOptions: Loader<SelectOptionsParams, SelectOption[]>;
    catalogMetadata: Loader<string, CatalogMetadataRow[]>;
    catalogDimensionNames: Loader<string, string[]>;
    compareFacts: Loader<CompareFactsParams, ComparisonResult>;
    compareAggregatedFacts: Loader<CompareAggregatedFactsParams, ComparisonResult>;
    crossDatabaseSelectOptions: Loader<CrossDatabaseSelectOptionsParams, CrossDatabaseSelectOption[]>;
    clearAll: () => void;
    prime: (initialData?: PrimeData) => Promise<void>;
}

// Fonction de création de l'ensemble des loaders pour un identifiant de base de données
/**
 * Creates and initializes all data loaders for a given database.
 *
 * Instantiates one DataLoader per query type. Catalog and cross-database
 * loaders are shared and independent of databaseId.
 *
 * @param databaseId - Catalog alias to use for all single-database loaders.
 *   Null uses the configured default database.
 * @returns LoadersCollection with all loaders plus clearAll and prime helpers.
 */
const createLoaders = (databaseId: string | null = null): LoadersCollection => {
    // Initialisation des loaders de méta-données et dimensions
    const metadataLoader = createMetadataLoader(databaseId);
    const dimensionLoader = createDimensionLoader(databaseId);
    const dimensionValueLoader = createDimensionValueLoader(databaseId);

    // Loaders pour les faits
    const factLoader = createFactLoader(databaseId);
    const factWithCountLoader = createFactWithCountLoader(databaseId);
    const factWithMetadataLoader = createFactWithMetadataLoader(databaseId);

    // Loaders pour les faits agrégés
    const aggregatedFactsLoader = createAggregatedFactsLoader(databaseId);
    const aggregatedFactsWithMetadataLoader = createAggregatedFactsWithMetadataLoader(databaseId);
    const aggregatedFactsWithCountLoader = createAggregatedFactsWithCountLoader(databaseId);

    const selectOptionsLoader = createSelectOptionsLoader(databaseId);

    // Loaders catalog et cross-database — partagés, indépendants du databaseId
    const catalogMetadataLoader = createCatalogMetadataLoader();
    const catalogDimensionNamesLoader = createCatalogDimensionNamesLoader();
    const compareFactsLoader = createCompareFacts();
    const compareAggregatedFactsLoader = createCompareAggregatedFacts();
    const crossDatabaseSelectOptionsLoader = createCrossDatabaseSelectOptions();

    // Retourne un objet avec l'ensemble des loaders et les méthodes utilitaires
    return {
        metadata: metadataLoader,
        dimension: dimensionLoader,
        dimensionValue: dimensionValueLoader,
        fact: factLoader,
        factWithCount: factWithCountLoader,
        factWithMetadata: factWithMetadataLoader,
        aggregatedFacts: aggregatedFactsLoader,
        aggregatedFactsWithMetadata: aggregatedFactsWithMetadataLoader,
        aggregatedFactsWithCount: aggregatedFactsWithCountLoader,
        selectOptions: selectOptionsLoader,
        catalogMetadata: catalogMetadataLoader,
        catalogDimensionNames: catalogDimensionNamesLoader,
        compareFacts: compareFactsLoader,
        compareAggregatedFacts: compareAggregatedFactsLoader,
        crossDatabaseSelectOptions: crossDatabaseSelectOptionsLoader,

        // Méthode de nettoyage du cache de l'ensemble des loaders
        clearAll: () => {
            metadataLoader.clearAll();
            dimensionLoader.clearAll();
            dimensionValueLoader.clearAll();
            factLoader.clearAll();
            factWithCountLoader.clearAll();
            factWithMetadataLoader.clearAll();
            aggregatedFactsLoader.clearAll();
            aggregatedFactsWithMetadataLoader.clearAll();
            aggregatedFactsWithCountLoader.clearAll();
            selectOptionsLoader.clearAll();
            catalogMetadataLoader.clearAll();
            catalogDimensionNamesLoader.clearAll();
            compareFactsLoader.clearAll();
            compareAggregatedFactsLoader.clearAll();
            crossDatabaseSelectOptionsLoader.clearAll();
        },

        // Méthode d'amorçage de tous les loaders avec leurs données initiales
        prime: async (initialData: PrimeData = {}) => {
            const {
                metadata = [],
                dimensions = [],
                dimensionValues = [],
                facts = [],
                factsWithCount = [],
                factsWithMetadata = [],
                aggregatedFacts = [],
                aggregatedFactsWithMetadata = [],
                aggregatedFactsWithCount = [],
                selectOptions = []
            } = initialData;

            // Amorçage de chaque loader avec ses données initiales
            metadata.forEach(({ key, value }) => { metadataLoader.prime(key, value); });
            dimensions.forEach(({ key, value }) => { dimensionLoader.prime(key, value); });
            dimensionValues.forEach(({ key, value }) => { dimensionValueLoader.prime(key, value); });
            facts.forEach(({ key, value }) => { factLoader.prime(key, value); });
            factsWithCount.forEach(({ key, value }) => { factWithCountLoader.prime(key, value); });
            factsWithMetadata.forEach(({ key, value }) => { factWithMetadataLoader.prime(key, value); });
            aggregatedFacts.forEach(({ key, value }) => { aggregatedFactsLoader.prime(key, value); });
            aggregatedFactsWithMetadata.forEach(({ key, value }) => { aggregatedFactsWithMetadataLoader.prime(key, value); });
            aggregatedFactsWithCount.forEach(({ key, value }) => { aggregatedFactsWithCountLoader.prime(key, value); });
            selectOptions.forEach(({ key, value }) => { selectOptionsLoader.prime(key, value); });
        }
    };
};

// Fonction pour créer de nouveaux loaders pour chaque requête entrante
/**
 * Creates a fresh set of data loaders for a single GraphQL request.
 *
 * Ensures per-request DataLoader instances to prevent data leaking
 * between concurrent requests while sharing the Redis cache layer.
 *
 * @param databaseId - Catalog alias to use; null uses the default database.
 * @returns New LoadersCollection for the current request.
 */
const createLoadersForRequest = (databaseId: string | null = null): LoadersCollection => {
    return createLoaders(databaseId);
};

export { createLoaders, createLoadersForRequest };
export type { LoadersCollection, PrimeData, KeyValuePair };
