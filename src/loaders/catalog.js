import { BaseQueryLoader } from './base-loader.js';
import { databaseManager } from '../db/index.js';
import { config } from '../utils/config-loader.js';

class CatalogMetadataLoader extends BaseQueryLoader {
    constructor() {
        super({
            batchSize: 1,
            cachePrefix: 'catalog-metadata',
            cache: true,
            cacheTimeout: config.API.LOADERS.DEFAULT_CACHE_TIMEOUT,
            databaseId: null
        });
    }

    async loadAllMetadata(connection, catalogId) {
        const schema = databaseManager.getSchema(catalogId);
        const query = `SELECT * FROM "${catalogId}".${schema}.metadata`;
        const rows = await connection.all(query);
        return rows.map(row => ({ ...row, is_categorical: Boolean(row.is_categorical) }));
    }
}

class CatalogDimensionNamesLoader extends BaseQueryLoader {
    constructor() {
        super({
            batchSize: 1,
            cachePrefix: 'catalog-dimension-names',
            cache: true,
            cacheTimeout: config.API.LOADERS.DEFAULT_CACHE_TIMEOUT,
            databaseId: null
        });
    }

    async loadDimensionNames(connection, catalogId) {
        const schema = databaseManager.getSchema(catalogId);
        const query = `SELECT name FROM "${catalogId}".${schema}.metadata WHERE is_categorical = true`;
        const results = await connection.all(query);
        return results.map(r => r.name);
    }
}

const createCatalogMetadataLoader = () => {
    const loader = new CatalogMetadataLoader();
    return loader.createLoader((connection, catalogId) =>
        loader.loadAllMetadata(connection, catalogId)
    );
};

const createCatalogDimensionNamesLoader = () => {
    const loader = new CatalogDimensionNamesLoader();
    return loader.createLoader((connection, catalogId) =>
        loader.loadDimensionNames(connection, catalogId)
    );
};

export { createCatalogMetadataLoader, createCatalogDimensionNamesLoader, CatalogMetadataLoader, CatalogDimensionNamesLoader };
