/**
 * Unit tests for FactLoader (src/loaders/fact.ts).
 *
 * Verifies fact loading for default, JSON, and metadata formats,
 * pagination metadata computation, table qualification, propagation of the
 * compiled filter parameters to every query path, and identifier validation
 * of fields / sort.
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 */

import { jest } from '@jest/globals';
import {
  makeLoaderConfig,
  makePool,
  makeExtendedConnection,
  makeDatabaseManager,
} from '../../helpers/mocks.js';

// ─── Interfaces ────────────────────────────────────────────────────────────────

/** Paramètres de base pour le chargement de faits. */
interface FactLoadParams {
  fields: string[] | null;
  where: { sql: string; params: unknown[] } | null;
  limit: number;
  offset: number;
  sort: Array<{ field: string; order: string }>;
  format?: string;
}

/** Instance d'un loader DataLoader — interface minimale. */
interface DataLoaderInstance {
  load: (params: unknown) => Promise<unknown>;
  loadMany?: (keys: unknown[]) => Promise<unknown[]>;
}

/** Module fact.ts après import dynamique. */
interface FactModule {
  createFactLoader: (databaseId?: string | null) => DataLoaderInstance;
  createFactWithCountLoader: (databaseId?: string | null) => DataLoaderInstance;
  createFactWithMetadataLoader: (databaseId?: string | null) => DataLoaderInstance;
  FactLoader: new (databaseId?: string | null) => unknown;
}

// ─── État des mocks partagés ───────────────────────────────────────────────────

// Connexion et pool réutilisés dans tous les tests du fichier
const mockPool = makePool();
const mockConnection = makeExtendedConnection();
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
let createFactLoader: FactModule['createFactLoader'];
let createFactWithCountLoader: FactModule['createFactWithCountLoader'];
let createFactWithMetadataLoader: FactModule['createFactWithMetadataLoader'];

beforeAll(async () => {
  ({ createFactLoader, createFactWithCountLoader, createFactWithMetadataLoader } =
    (await import('../../../src/loaders/fact.js')) as unknown as FactModule);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FactLoader', () => {
  // Paramètres de base réutilisés dans chaque test
  const baseParams: FactLoadParams = {
    fields: ['id', 'value'],
    where: null,
    limit: 10,
    offset: 0,
    sort: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockDatabaseManager.getPool.mockReturnValue(mockPool);
    mockDatabaseManager.getDefaultSchema.mockReturnValue('main');
    mockPool.acquire.mockResolvedValue(mockConnection);
  });

  // ── Instanciation ─────────────────────────────────────────────────────────

  describe('createFactLoader', () => {
    test('crée un DataLoader valide', () => {
      const loader = createFactLoader('main');
      expect(loader).toBeDefined();
      expect(typeof loader.load).toBe('function');
    });

    test('fonctionne sans databaseId', () => {
      const loader = createFactLoader();
      expect(loader).toBeDefined();
    });

    test('qualifie la table avec le schéma explicite lors de la requête SQL', async () => {
      mockConnection.all.mockResolvedValue([]);

      // catalog explicite + schema non-défaut : on doit voir "catalog1".staging.fact_table
      const loader = createFactLoader('catalog1', 'staging');
      await loader.load({ ...baseParams });

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toContain('"catalog1".staging.fact_table');
      // L'appel à getDefaultSchema ne doit PAS être nécessaire (schéma fourni explicitement)
      expect(mockDatabaseManager.getDefaultSchema).not.toHaveBeenCalled();
    });

    test('retombe sur le schéma par défaut quand schema est absent', async () => {
      mockConnection.all.mockResolvedValue([]);
      mockDatabaseManager.getDefaultSchema.mockReturnValue('main');

      const loader = createFactLoader('catalog1'); // pas de schema
      await loader.load({ ...baseParams });

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toContain('"catalog1".main.fact_table');
      expect(mockDatabaseManager.getDefaultSchema).toHaveBeenCalledWith('catalog1');
    });
  });

  // ── Chargement au format par défaut ──────────────────────────────────────

  describe('loadFacts - format default', () => {
    test('retourne un tableau de lignes', async () => {
      const rows = [
        { id: 1, value: 100 },
        { id: 2, value: 200 },
      ];
      mockConnection.all.mockResolvedValue(rows);

      const loader = createFactLoader('main');
      const result = await loader.load({ ...baseParams });

      expect(result).toEqual(rows);
    });

    test('inclut la clause WHERE compilée et transmet ses paramètres', async () => {
      mockConnection.all.mockResolvedValue([]);

      const loader = createFactLoader('main');
      await loader.load({ ...baseParams, where: { sql: '"country" = ?', params: ['FR'] } });

      const [query, params] = mockConnection.all.mock.calls[0];
      expect(query).toContain('WHERE "country" = ?');
      expect(params).toEqual(['FR']);
    });

    test("n'ajoute pas de WHERE et passe une liste de paramètres vide sans filtre", async () => {
      mockConnection.all.mockResolvedValue([]);

      const loader = createFactLoader('main');
      await loader.load({ ...baseParams });

      const [query, params] = mockConnection.all.mock.calls[0];
      expect(query).not.toContain('WHERE');
      expect(params).toEqual([]);
    });

    test('rejette un champ de sélection malformé', async () => {
      const loader = createFactLoader('main');
      await expect(
        loader.load({ ...baseParams, fields: ['id', 'a; DROP TABLE fact_table'] }),
      ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
      expect(mockConnection.all).not.toHaveBeenCalled();
    });

    test('rejette un champ de tri malformé', async () => {
      const loader = createFactLoader('main');
      await expect(
        loader.load({ ...baseParams, sort: [{ field: 'a; DROP TABLE x', order: 'ASC' }] }),
      ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    });

    test('rejette une direction de tri hors ASC / DESC', async () => {
      const loader = createFactLoader('main');
      await expect(
        loader.load({ ...baseParams, sort: [{ field: 'value', order: 'DESC; DROP' }] }),
      ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    });

    test('inclut ORDER BY pour le tri', async () => {
      mockConnection.all.mockResolvedValue([]);

      const loader = createFactLoader('main');
      await loader.load({ ...baseParams, sort: [{ field: 'value', order: 'DESC' }] });

      const query = mockConnection.all.mock.calls[0][0];
      expect(query).toContain('ORDER BY value DESC');
    });

    test('inclut LIMIT et OFFSET', async () => {
      mockConnection.all.mockResolvedValue([]);

      const loader = createFactLoader('main');
      await loader.load({ ...baseParams, limit: 5, offset: 10 });

      const query = mockConnection.all.mock.calls[0][0];
      expect(query).toContain('LIMIT 5');
      expect(query).toContain('OFFSET 10');
    });

    test('lève une erreur si limit dépasse MAX_LIMIT', async () => {
      const loader = createFactLoader('main');
      // Dépassement de la limite — erreur attrapée par createLoader → null
      const result = await loader.load({ ...baseParams, limit: 9999 });
      expect(result).toBeNull();
    });
  });

  // ── Chargement au format JSON ─────────────────────────────────────────────

  describe('loadFacts - format json', () => {
    test('utilise getAsJsonArray pour le format json', async () => {
      mockConnection.getAsJsonArray.mockResolvedValue('[{"id":1}]');

      const loader = createFactLoader('main');
      const result = await loader.load({
        ...baseParams,
        format: 'json',
        where: { sql: '"value" > CAST(? AS DOUBLE)', params: [3] },
      });

      expect(mockConnection.getAsJsonArray).toHaveBeenCalledWith(
        expect.stringContaining('WHERE "value" > CAST(? AS DOUBLE)'),
        [3],
      );
      expect(result).toBe('[{"id":1}]');
    });
  });

  // ── Chargement au format metadata ─────────────────────────────────────────

  describe('loadFacts - format metadata', () => {
    test('utilise getWithMetadata pour le format metadata', async () => {
      const metaResult = { data: [{ id: 1 }], metadata: { columns: [] } };
      mockConnection.getWithMetadata.mockResolvedValue(metaResult);
      mockConnection.all.mockResolvedValue([{ total: 5 }]);

      const where = { sql: '"country" IN (CAST(? AS BIGINT), CAST(? AS BIGINT))', params: [1, 2] };
      const loader = createFactWithMetadataLoader('main');
      await loader.load({ ...baseParams, where });

      // Requête de données et requête de comptage reçoivent les mêmes paramètres
      expect(mockConnection.getWithMetadata).toHaveBeenCalledWith(
        expect.stringContaining(`WHERE ${where.sql}`),
        [1, 2],
      );
      const [countQuery, countParams] = mockConnection.all.mock.calls[0];
      expect(countQuery).toContain('COUNT(*)');
      expect(countQuery).toContain(`WHERE ${where.sql}`);
      expect(countParams).toEqual([1, 2]);
    });
  });

  // ── Chargement avec comptage total ────────────────────────────────────────

  describe('createFactWithCountLoader', () => {
    test('retourne les données avec le comptage total', async () => {
      const rows = [{ id: 1, value: 100 }];
      mockConnection.all
        .mockResolvedValueOnce(rows) // données principales
        .mockResolvedValueOnce([{ total: 42 }]); // comptage total

      const loader = createFactWithCountLoader('main');
      const result = (await loader.load({ ...baseParams })) as Record<string, unknown>;

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total', 42);
      expect(result).toHaveProperty('hasNextPage');
      expect(result).toHaveProperty('currentPage');
      expect(result).toHaveProperty('totalPages');
    });

    test('transmet les paramètres du filtre à la requête de comptage', async () => {
      mockConnection.all.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

      const loader = createFactWithCountLoader('main');
      await loader.load({ ...baseParams, where: { sql: '"kind" = ?', params: ['x'] } });

      expect(mockConnection.all.mock.calls[0][1]).toEqual(['x']);
      expect(mockConnection.all.mock.calls[1][0]).toContain('WHERE "kind" = ?');
      expect(mockConnection.all.mock.calls[1][1]).toEqual(['x']);
    });

    test('calcule hasNextPage correctement', async () => {
      mockConnection.all
        .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
        .mockResolvedValueOnce([{ total: 20 }]);

      const loader = createFactWithCountLoader('main');
      const result = (await loader.load({ ...baseParams, limit: 2, offset: 0 })) as Record<
        string,
        unknown
      >;

      expect(result.hasNextPage).toBe(true);
      expect(result.currentPage).toBe(1);
      expect(result.totalPages).toBe(10);
    });

    test('hasNextPage est false quand on est à la dernière page', async () => {
      mockConnection.all.mockResolvedValueOnce([{ id: 1 }]).mockResolvedValueOnce([{ total: 5 }]);

      const loader = createFactWithCountLoader('main');
      const result = (await loader.load({ ...baseParams, limit: 10, offset: 0 })) as Record<
        string,
        unknown
      >;

      expect(result.hasNextPage).toBe(false);
    });
  });

  // ── Qualification du nom de table ─────────────────────────────────────────

  describe('qualifyTable', () => {
    test('utilise le bon catalogue dans la requête', async () => {
      mockConnection.all.mockResolvedValue([]);

      const loader = createFactLoader('mydb');
      await loader.load({ ...baseParams });

      const query = mockConnection.all.mock.calls[0][0];
      expect(query).toContain('"mydb"');
      expect(query).toContain('fact_table');
    });
  });
});
