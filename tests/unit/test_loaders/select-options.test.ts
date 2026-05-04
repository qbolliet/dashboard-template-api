/**
 * Unit tests for SelectOptionsLoader (src/loaders/select-options.ts).
 *
 * Verifies option loading from dimension tables for categorical fields,
 * from fact_table for non-categorical fields, searchTerm filtering,
 * error handling, and string coercion of all values.
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

/** Paramètres de chargement des options de sélection. */
interface SelectOptionsParams {
  fieldName: string;
  limit: number;
  searchTerm: string | null;
}

/** Option retournée par le loader. */
interface SelectOption {
  value: string;
  label: string;
}

/** Instance d'un loader DataLoader — interface minimale. */
interface DataLoaderInstance {
  load: (params: SelectOptionsParams) => Promise<SelectOption[] | null>;
}

/** Module select-options.ts après import dynamique. */
interface SelectOptionsModule {
  createSelectOptionsLoader: (databaseId?: string | null) => DataLoaderInstance;
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
}));

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: mockConfig,
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Déclaration avant beforeAll — remplie après résolution des mocks
let createSelectOptionsLoader: SelectOptionsModule['createSelectOptionsLoader'];

beforeAll(async () => {
  ({ createSelectOptionsLoader } =
    await import('../../../src/loaders/select-options.js') as unknown as SelectOptionsModule);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SelectOptionsLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDatabaseManager.getPool.mockReturnValue(mockPool);
    mockDatabaseManager.getSchema.mockReturnValue('main');
    mockPool.acquire.mockResolvedValue(mockConnection);
  });

  // ── Instanciation ─────────────────────────────────────────────────────────

  describe('createSelectOptionsLoader', () => {
    test('crée un DataLoader valide', () => {
      const loader = createSelectOptionsLoader('main');
      expect(loader).toBeDefined();
      expect(typeof loader.load).toBe('function');
    });

    test('fonctionne sans databaseId', () => {
      const loader = createSelectOptionsLoader();
      expect(loader).toBeDefined();
    });
  });

  // ── Chargement pour un champ catégoriel ───────────────────────────────────

  describe('loadSelectOptions - champ catégoriel', () => {
    test('charge depuis la table de dimension pour un champ catégoriel', async () => {
      mockConnection.all
        .mockResolvedValueOnce([{ is_categorical: 1 }])         // métadonnée
        .mockResolvedValueOnce([                                 // table de dimension
          { value: '1', label: 'France' },
          { value: '2', label: 'Allemagne' },
        ]);

      const loader = createSelectOptionsLoader('main');
      const result = await loader.load({ fieldName: 'country', limit: 50, searchTerm: null });

      expect(result).toEqual([
        { value: '1', label: 'France' },
        { value: '2', label: 'Allemagne' },
      ]);
      const dimQuery = mockConnection.all.mock.calls[1][0] as string;
      expect(dimQuery).toContain('dim_country');
    });

    test('filtre par searchTerm dans la dimension', async () => {
      mockConnection.all
        .mockResolvedValueOnce([{ is_categorical: 1 }])
        .mockResolvedValueOnce([{ value: '1', label: 'France' }]);

      const loader = createSelectOptionsLoader('main');
      await loader.load({ fieldName: 'country', limit: 50, searchTerm: 'fra' });

      const dimQuery = mockConnection.all.mock.calls[1][0] as string;
      expect(dimQuery).toContain('LIKE');
      expect(mockConnection.all.mock.calls[1][1]).toContain('%fra%');
    });
  });

  // ── Chargement pour un champ non catégoriel ───────────────────────────────

  describe('loadSelectOptions - champ non catégoriel', () => {
    test('charge les valeurs distinctes depuis la table des faits', async () => {
      mockConnection.all
        .mockResolvedValueOnce([{ is_categorical: 0 }])         // métadonnée
        .mockResolvedValueOnce([                                 // table des faits
          { value: '100' },
          { value: '200' },
        ]);

      const loader = createSelectOptionsLoader('main');
      const result = await loader.load({ fieldName: 'amount', limit: 50, searchTerm: null });

      expect(result).toEqual([
        { value: '100', label: '100' },
        { value: '200', label: '200' },
      ]);
      const factQuery = mockConnection.all.mock.calls[1][0] as string;
      expect(factQuery).toContain('DISTINCT');
      expect(factQuery).toContain('fact_table');
    });

    test('filtre par searchTerm dans les faits', async () => {
      mockConnection.all
        .mockResolvedValueOnce([{ is_categorical: 0 }])
        .mockResolvedValueOnce([]);

      const loader = createSelectOptionsLoader('main');
      await loader.load({ fieldName: 'amount', limit: 50, searchTerm: '10' });

      const factQuery = mockConnection.all.mock.calls[1][0] as string;
      expect(factQuery).toContain('LIKE');
      expect(mockConnection.all.mock.calls[1][1]).toContain('%10%');
    });
  });

  // ── Gestion des cas d'erreur ──────────────────────────────────────────────

  describe("loadSelectOptions - cas d'erreur", () => {
    test('retourne un tableau vide si le champ est introuvable en metadata', async () => {
      // is_categorical indéfini → traitement comme non catégoriel
      mockConnection.all.mockResolvedValueOnce([]);

      const loader = createSelectOptionsLoader('main');
      const result = await loader.load({ fieldName: 'country', limit: 50, searchTerm: null });

      expect(Array.isArray(result)).toBe(true);
    });

    test("retourne un tableau vide en cas d'erreur SQL", async () => {
      mockConnection.all.mockRejectedValue(new Error('DB error'));

      const loader = createSelectOptionsLoader('main');
      const result = await loader.load({ fieldName: 'country', limit: 50, searchTerm: null });

      expect(result).toEqual([]);
    });

    test('lève une erreur pour un nom de champ invalide', async () => {
      const loader = createSelectOptionsLoader('main');
      // validateIdentifier lance une erreur → attrapée → tableau vide
      const result = await loader.load({ fieldName: 'bad field!', limit: 50, searchTerm: null });
      expect(result).toEqual([]);
    });
  });

  // ── Conversion des valeurs en chaînes ─────────────────────────────────────

  describe('string conversion des valeurs', () => {
    test('convertit toutes les valeurs en chaînes', async () => {
      mockConnection.all
        .mockResolvedValueOnce([{ is_categorical: 1 }])
        .mockResolvedValueOnce([{ value: 42, label: 'Quarante-deux' }]);

      const loader = createSelectOptionsLoader('main');
      const result = await loader.load({ fieldName: 'rank', limit: 10, searchTerm: null });

      expect(result![0].value).toBe('42');
    });
  });
});
