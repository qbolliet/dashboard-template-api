/**
 * Unit tests for SelectOptionsLoader (src/loaders/select-options.ts).
 *
 * The fact table stores labels directly, so there is a single load path:
 * a DISTINCT scan of the column with `label = value`. Verifies that path,
 * NULL exclusion, ordering, searchTerm parameterization (with escaped LIKE
 * wildcards), string coercion, and the errors raised for an unknown or
 * malformed field name.
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 */

import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';
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
    (await import('../../../src/loaders/select-options.js')) as unknown as SelectOptionsModule);
});

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

/**
 * Makes the metadata lookup succeed, then returns the given rows.
 *
 * @param rows - Rows the DISTINCT query resolves to.
 */
// Colonne déclarée en metadata, puis résultat du SELECT DISTINCT
const mockDeclaredField = (rows: Record<string, unknown>[]): void => {
  mockConnection.all
    .mockResolvedValueOnce([{ name: 'country' }])
    .mockResolvedValueOnce(rows as never);
};

/** Returns the SQL of the DISTINCT query (second call) and its parameters. */
const distinctCall = (): [string, unknown[]] => [
  mockConnection.all.mock.calls[1][0] as string,
  mockConnection.all.mock.calls[1][1] as unknown[],
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SelectOptionsLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDatabaseManager.getPool.mockReturnValue(mockPool);
    mockDatabaseManager.getDefaultSchema.mockReturnValue('main');
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

  // ── Chemin unique : DISTINCT sur la fact table ────────────────────────────

  describe('loadSelectOptions', () => {
    test('charge les valeurs distinctes de la fact table, label = value', async () => {
      mockDeclaredField([{ value: 'France' }, { value: 'Germany' }]);

      const loader = createSelectOptionsLoader('main');
      const result = await loader.load({ fieldName: 'country', limit: 50, searchTerm: null });

      // La fact table porte le libellé : aucune résolution supplémentaire
      expect(result).toEqual([
        { value: 'France', label: 'France' },
        { value: 'Germany', label: 'Germany' },
      ]);
    });

    test('interroge la fact table, jamais une table dim_*', async () => {
      mockDeclaredField([{ value: 'France' }]);

      const loader = createSelectOptionsLoader('main');
      await loader.load({ fieldName: 'country', limit: 50, searchTerm: null });

      const [sql] = distinctCall();
      expect(sql).toContain('DISTINCT');
      expect(sql).toContain('fact_table');
      expect(sql).not.toContain('dim_');
    });

    test('exclut les valeurs NULL et trie les modalités', async () => {
      mockDeclaredField([{ value: 'France' }]);

      const loader = createSelectOptionsLoader('main');
      await loader.load({ fieldName: 'country', limit: 50, searchTerm: null });

      const [sql, params] = distinctCall();
      expect(sql).toContain('IS NOT NULL');
      expect(sql).toContain('ORDER BY country');
      // La limite passe en paramètre lié, jamais interpolée
      expect(params).toEqual([50]);
    });

    test('passe le terme de recherche en paramètre, insensible à la casse', async () => {
      mockDeclaredField([{ value: "Côte-d'Or" }]);

      const loader = createSelectOptionsLoader('main');
      await loader.load({ fieldName: 'country', limit: 50, searchTerm: 'CÔTE' });

      const [sql, params] = distinctCall();
      expect(sql).toContain('LIKE ?');
      expect(sql).toContain('LOWER(');
      expect(params[0]).toBe('%côte%');
    });

    test('échappe les jokers LIKE du terme de recherche', async () => {
      mockDeclaredField([]);

      const loader = createSelectOptionsLoader('main');
      await loader.load({ fieldName: 'country', limit: 50, searchTerm: '100%_x' });

      const [sql, params] = distinctCall();
      expect(sql).toContain("ESCAPE '\\'");
      // Les jokers du terme deviennent littéraux
      expect(params[0]).toBe('%100\\%\\_x%');
    });

    test('convertit toutes les valeurs en chaînes', async () => {
      mockDeclaredField([{ value: 42 }]);

      const loader = createSelectOptionsLoader('main');
      const result = await loader.load({ fieldName: 'country', limit: 10, searchTerm: null });

      expect(result![0]).toEqual({ value: '42', label: '42' });
    });
  });

  // ── Gestion des cas d'erreur ──────────────────────────────────────────────

  describe("loadSelectOptions - cas d'erreur", () => {
    test('champ inconnu de metadata → BAD_USER_INPUT', async () => {
      // Aucune ligne de metadata pour cette colonne
      mockConnection.all.mockResolvedValueOnce([]);

      const loader = createSelectOptionsLoader('main');
      await expect(
        loader.load({ fieldName: 'unknown_field', limit: 50, searchTerm: null }),
      ).rejects.toThrow(GraphQLError);

      // La requête DISTINCT n'est jamais émise
      expect(mockConnection.all).toHaveBeenCalledTimes(1);
    });

    test('erreur SQL non masquée en tableau vide', async () => {
      mockConnection.all.mockRejectedValue(new Error('DB error'));

      const loader = createSelectOptionsLoader('main');
      const result = await loader.load({ fieldName: 'country', limit: 50, searchTerm: null });

      // L'ancien catch { return []; } présentait l'échec comme « aucune option ».
      // Le loader n'avale plus rien : la politique commune de BaseQueryLoader
      // (journalisation + null pour une erreur non métier) s'applique, et le
      // champ non-nullable du SDL transforme ce null en erreur côté client.
      expect(result).toBeNull();
    });

    test('nom de champ invalide rejeté avant toute requête', async () => {
      const loader = createSelectOptionsLoader('main');
      await expect(
        loader.load({ fieldName: 'bad field!', limit: 50, searchTerm: null }),
      ).rejects.toThrow();

      expect(mockConnection.all).not.toHaveBeenCalled();
    });
  });
});
