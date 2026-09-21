/**
 * Unit tests for CatalogMetadataLoader (src/loaders/catalog.ts).
 *
 * Verifies full-catalog metadata retrieval with boolean coercion
 * and SQL query qualification.
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 */

import { jest } from '@jest/globals';
import {
  makeLoaderConfig,
  makePool,
  makeConnection,
  makeDatabaseManager,
} from '../../helpers/mocks.js';

// ─── Interfaces ────────────────────────────────────────────────────────────────

/** Ligne brute de la table metadata, en snake_case. */
interface MetadataRow {
  name: string;
  sql_type?: string;
  is_categorical: number | boolean;
}

/** Métadonnée exposée par le loader — camelCase, booléen converti. */
interface MetadataResult {
  name: string;
  sqlType: string;
  isCategorical: boolean;
}

/** Instance d'un loader DataLoader — interface minimale. */
interface DataLoaderInstance {
  load: (key: string) => Promise<unknown>;
}

/** Module catalog.ts après import dynamique. */
interface CatalogModule {
  createCatalogMetadataLoader: () => DataLoaderInstance;
}

// ─── État des mocks partagés ───────────────────────────────────────────────────

// Connexion et pool réutilisés dans tous les tests du fichier
const mockPool = makePool();
const mockConnection = makeConnection();
const mockDatabaseManager = makeDatabaseManager(mockPool);
const mockConfig = makeLoaderConfig();

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/db/index.js', () => ({
  databaseManager: mockDatabaseManager,
}));

jest.unstable_mockModule('../../../src/utils/cache.js', () => ({
  withCache: jest.fn().mockImplementation(async (_k: unknown, fn: () => Promise<unknown>) => fn()),
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn() },
  // La garde de version (db/schema-version.js) crée son propre logger contextuel
  createContextLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    database: jest.fn(),
  }),
}));

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: mockConfig,
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Déclarations avant beforeAll — remplies après résolution des mocks
let createCatalogMetadataLoader: CatalogModule['createCatalogMetadataLoader'];

beforeAll(async () => {
  ({ createCatalogMetadataLoader } =
    (await import('../../../src/loaders/catalog.js')) as unknown as CatalogModule);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CatalogMetadataLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDatabaseManager.getPool.mockReturnValue(mockPool);
    mockDatabaseManager.getDefaultSchema.mockReturnValue('main');
    mockPool.acquire.mockResolvedValue(mockConnection);
  });

  // ── Instanciation ─────────────────────────────────────────────────────────

  describe('createCatalogMetadataLoader', () => {
    test('crée un DataLoader valide', () => {
      const loader = createCatalogMetadataLoader();
      expect(loader).toBeDefined();
      expect(typeof loader.load).toBe('function');
    });
  });

  // ── Chargement de toutes les métadonnées d'un catalogue ───────────────────

  describe('loadAllMetadata', () => {
    test('charge toutes les métadonnées pour un catalogue', async () => {
      mockConnection.all.mockResolvedValue([
        { name: 'age', sql_type: 'INTEGER', is_categorical: 0 },
        { name: 'country', sql_type: 'VARCHAR', is_categorical: 1 },
      ]);

      const loader = createCatalogMetadataLoader();
      const result = (await loader.load({ catalog: 'catalog1' })) as MetadataResult[];

      expect(result).toHaveLength(2);
      expect(result[0].isCategorical).toBe(false);
      expect(result[0].sqlType).toBe('INTEGER');
      expect(result[1].isCategorical).toBe(true);
    });

    test('convertit is_categorical en isCategorical booléen', async () => {
      mockConnection.all.mockResolvedValue([
        { name: 'status', is_categorical: 1 },
        { name: 'score', is_categorical: 0 },
      ]);

      const loader = createCatalogMetadataLoader();
      const result = (await loader.load({ catalog: 'mydb' })) as MetadataResult[];

      expect(result[0].isCategorical).toBe(true);
      expect(result[1].isCategorical).toBe(false);
    });

    test('utilise le bon catalogue dans la requête SQL', async () => {
      mockConnection.all.mockResolvedValue([]);

      const loader = createCatalogMetadataLoader();
      await loader.load({ catalog: 'catalog_abc' });

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toContain('"catalog_abc"');
      expect(query).toContain('metadata');
    });

    test("appelle getDefaultSchema avec l'id du catalogue quand schema est absent", async () => {
      mockConnection.all.mockResolvedValue([]);

      const loader = createCatalogMetadataLoader();
      await loader.load({ catalog: 'mydb' });

      expect(mockDatabaseManager.getDefaultSchema).toHaveBeenCalledWith('mydb');
    });

    test('utilise le schéma explicite et ignore le défaut quand fourni', async () => {
      mockConnection.all.mockResolvedValue([]);

      const loader = createCatalogMetadataLoader();
      await loader.load({ catalog: 'mydb', schema: 'staging' });

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toContain('"mydb".staging.metadata');
      // Pas de fallback : getDefaultSchema ne doit pas être appelé quand schema est fourni
      expect(mockDatabaseManager.getDefaultSchema).not.toHaveBeenCalled();
    });

    test('discrimine deux schémas du même catalogue dans le cache DataLoader', async () => {
      // Deux retours différents pour les deux clés (catalog, schema) distinctes
      mockConnection.all
        .mockResolvedValueOnce([{ name: 'a', is_categorical: 1 }])
        .mockResolvedValueOnce([{ name: 'b', is_categorical: 1 }]);

      const loader = createCatalogMetadataLoader();
      const r1 = (await loader.load({ catalog: 'mydb', schema: 'main' })) as MetadataResult[];
      const r2 = (await loader.load({ catalog: 'mydb', schema: 'staging' })) as MetadataResult[];

      // Les deux clés ont produit deux SQL différents et deux résultats distincts
      expect(r1).not.toEqual(r2);
      expect(mockConnection.all).toHaveBeenCalledTimes(2);
      const sqlA = mockConnection.all.mock.calls[0][0] as string;
      const sqlB = mockConnection.all.mock.calls[1][0] as string;
      expect(sqlA).toContain('"mydb".main.metadata');
      expect(sqlB).toContain('"mydb".staging.metadata');
    });

    test('retourne un tableau vide si aucune métadonnée', async () => {
      mockConnection.all.mockResolvedValue([]);

      const loader = createCatalogMetadataLoader();
      const result = await loader.load({ catalog: 'empty_catalog' });

      expect(result).toEqual([]);
    });
  });
});
