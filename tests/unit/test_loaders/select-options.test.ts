/**
 * Unit tests for SelectOptionsLoader (src/loaders/select-options.ts).
 *
 * The fact table stores labels directly, so there is a single load path:
 * a DISTINCT scan of the column with `label = value`. Verifies that path,
 * NULL exclusion, ordering, searchTerm parameterization (with escaped LIKE
 * wildcards), string coercion, and the errors raised for an unknown or
 * malformed field name. A code column with a label column reads (code, label)
 * in the same DISTINCT, searches both, and keys its cache on the label column.
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
  labelField?: string | null;
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

/** Paramètres de chargement d'un arbre d'options. */
interface SelectOptionsTreeParams {
  fieldName: string;
  maxDepth: number | null;
  searchTerm: string | null;
  maxNodes: number;
}

/** Nœud d'arbre retourné par le loader. */
interface TreeNode {
  value: string;
  label: string;
  children?: TreeNode[];
}

/** Instance du loader d'arbres — interface minimale. */
interface TreeLoaderInstance {
  load: (params: SelectOptionsTreeParams) => Promise<TreeNode[] | null>;
}

/** Module select-options.ts après import dynamique. */
interface SelectOptionsModule {
  createSelectOptionsLoader: (databaseId?: string | null) => DataLoaderInstance;
  createSelectOptionsTreeLoader: (databaseId?: string | null) => TreeLoaderInstance;
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

// Déclaration avant beforeAll — remplie après résolution des mocks
let createSelectOptionsLoader: SelectOptionsModule['createSelectOptionsLoader'];
let createSelectOptionsTreeLoader: SelectOptionsModule['createSelectOptionsTreeLoader'];
// Mock de withCache, inspecté par les tests de clé de cache
let withCacheMock: jest.Mock;

beforeAll(async () => {
  ({ createSelectOptionsLoader, createSelectOptionsTreeLoader } =
    (await import('../../../src/loaders/select-options.js')) as unknown as SelectOptionsModule);
  withCacheMock = (await import('../../../src/utils/cache.js')).withCache as unknown as jest.Mock;
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

// ─── Arbre d'options d'une hiérarchie de colonnes ──────────────────────────────

/**
 * Makes the metadata read return the given parent links, then the DISTINCT
 * query return the given rows.
 *
 * @param parents - Column name → parent column name (null for a root).
 * @param rows - Rows the DISTINCT query resolves to.
 */
// Métadonnées (liens parent_name) puis lignes du SELECT DISTINCT
const mockHierarchy = (
  parents: Record<string, string | null>,
  rows: Record<string, unknown>[] = [],
): void => {
  mockConnection.all
    .mockResolvedValueOnce(
      Object.entries(parents).map(([name, parent]) => ({ name, parent_name: parent })) as never,
    )
    .mockResolvedValueOnce(rows as never);
};

// Chaîne region → departement → commune du setup de test
const GEOGRAPHY = { region: null, departement: 'region', commune: 'departement' };

/**
 * Loads a tree with default parameters overridden by `params`.
 *
 * @param params - Parameters to override.
 * @returns The loaded tree.
 */
// Chargement d'un arbre, paramètres par défaut surchargés
const loadTree = (params: Partial<SelectOptionsTreeParams> = {}) =>
  createSelectOptionsTreeLoader('main').load({
    fieldName: 'commune',
    maxDepth: null,
    searchTerm: null,
    maxNodes: 5000,
    ...params,
  });

describe('SelectOptionsTreeLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection.all.mockReset();
    mockDatabaseManager.getPool.mockReturnValue(mockPool);
    mockDatabaseManager.getDefaultSchema.mockReturnValue('main');
    mockPool.acquire.mockResolvedValue(mockConnection);
  });

  test('une seule requête DISTINCT sur la chaîne, racine non NULL, triée et plafonnée', async () => {
    mockHierarchy(GEOGRAPHY);

    await loadTree({ maxNodes: 100 });

    const [sql, params] = distinctCall();
    expect(sql).toContain('SELECT DISTINCT region, departement, commune');
    expect(sql).toContain('fact_table');
    expect(sql).toContain('WHERE region IS NOT NULL');
    expect(sql).toContain('ORDER BY region, departement, commune LIMIT ?');
    // Plafond maxNodes + 1 en paramètre lié
    expect(params).toEqual([101]);
    // Métadonnées + DISTINCT : deux requêtes au total
    expect(mockConnection.all).toHaveBeenCalledTimes(2);
  });

  test('maxDepth tronque la chaîne en remontant depuis fieldName', async () => {
    mockHierarchy(GEOGRAPHY);

    await loadTree({ maxDepth: 2 });

    const [sql] = distinctCall();
    expect(sql).toContain('SELECT DISTINCT departement, commune');
    expect(sql).toContain('WHERE departement IS NOT NULL');
  });

  test('searchTerm filtre le niveau fieldName, jokers échappés', async () => {
    mockHierarchy(GEOGRAPHY);

    await loadTree({ searchTerm: 'Me_%' });

    const [sql, params] = distinctCall();
    expect(sql).toContain("LOWER(CAST(commune AS VARCHAR)) LIKE ? ESCAPE '\\'");
    expect(params[0]).toBe('%me\\_\\%%');
  });

  test('construit l’arbre, une branche s’arrêtant au premier NULL', async () => {
    mockHierarchy(GEOGRAPHY, [
      { region: 'R1', departement: 'D1', commune: 'C1' },
      { region: 'R1', departement: 'D1', commune: 'C2' },
      { region: 'R1', departement: 'D2', commune: null },
      { region: 'R2', departement: null, commune: null },
    ]);

    const tree = await loadTree();

    expect(tree).toEqual([
      {
        value: 'R1',
        label: 'R1',
        children: [
          {
            value: 'D1',
            label: 'D1',
            children: [
              { value: 'C1', label: 'C1' },
              { value: 'C2', label: 'C2' },
            ],
          },
          // Niveau absent : feuille, aucun nœud vide
          { value: 'D2', label: 'D2' },
        ],
      },
      { value: 'R2', label: 'R2' },
    ]);
  });

  test('garde-fou anti-cycle : une chaîne corrompue ne boucle pas', async () => {
    // Cycle a → b → c → a : interdit par le writer, toléré à la lecture
    mockHierarchy({ a: 'c', b: 'a', c: 'b' });

    await loadTree({ fieldName: 'c' });

    const [sql] = distinctCall();
    expect(sql).toContain('SELECT DISTINCT a, b, c');
  });

  test('une parente non déclarée arrête la remontée', async () => {
    mockHierarchy({ commune: 'ghost' });

    await loadTree();

    const [sql] = distinctCall();
    expect(sql).toContain('SELECT DISTINCT commune FROM');
  });

  test('une parente au nom invalide est rejetée avant la requête DISTINCT', async () => {
    mockHierarchy({ commune: 'bad name', 'bad name': null });

    await expect(loadTree()).rejects.toThrow(GraphQLError);
    expect(mockConnection.all).toHaveBeenCalledTimes(1);
  });

  test('maxDepth < 1 rejeté avant toute requête', async () => {
    await expect(loadTree({ maxDepth: 0 })).rejects.toThrow('maxDepth');
    expect(mockConnection.all).not.toHaveBeenCalled();
  });

  test('champ inconnu de metadata → BAD_USER_INPUT, sans requête DISTINCT', async () => {
    mockHierarchy(GEOGRAPHY);

    await expect(loadTree({ fieldName: 'unknown' })).rejects.toThrow("Unknown field 'unknown'");
    expect(mockConnection.all).toHaveBeenCalledTimes(1);
  });

  test('dépassement de maxNodes → BAD_USER_INPUT, jamais tronqué', async () => {
    mockHierarchy(GEOGRAPHY, [
      { region: 'R1', departement: 'D1', commune: 'C1' },
      { region: 'R1', departement: 'D1', commune: 'C2' },
    ]);

    // 2 lignes ≤ 3, mais 4 nœuds > 3 : rejet à la construction
    const error = await loadTree({ maxNodes: 3 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
    expect((error as GraphQLError).message).toContain('exceeds 3 nodes');
  });
});

// ─── Colonnes de libellés (spec §2.6) ─────────────────────────────────────────

describe('SelectOptionsLoader — colonne de code dotée de libellés', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection.all.mockReset();
    mockDatabaseManager.getPool.mockReturnValue(mockPool);
    mockDatabaseManager.getDefaultSchema.mockReturnValue('main');
    mockPool.acquire.mockResolvedValue(mockConnection);
  });

  test('lit le couple (code, libellé) dans le même DISTINCT, trié par value', async () => {
    mockDeclaredField([{ value: '01012100', label: 'Pure-bred breeding horses' }]);

    const result = await createSelectOptionsLoader('main').load({
      fieldName: 'nc8',
      limit: 10,
      searchTerm: null,
      labelField: 'nc8_libelle_en',
    });

    const [sql, params] = distinctCall();
    expect(sql).toContain('SELECT DISTINCT CAST(nc8 AS VARCHAR) AS value, nc8_libelle_en AS label');
    expect(sql).toContain('WHERE nc8 IS NOT NULL');
    expect(sql).toContain('ORDER BY value LIMIT ?');
    expect(params).toEqual([10]);
    expect(result).toEqual([{ value: '01012100', label: 'Pure-bred breeding horses' }]);
  });

  test('searchTerm porte sur le code OU le libellé, jokers échappés', async () => {
    mockDeclaredField([]);

    await createSelectOptionsLoader('main').load({
      fieldName: 'nc8',
      limit: 10,
      searchTerm: '10%',
      labelField: 'nc8_libelle_fr',
    });

    const [sql, params] = distinctCall();
    expect(sql).toContain(
      "AND (LOWER(CAST(nc8 AS VARCHAR)) LIKE ? ESCAPE '\\' OR LOWER(nc8_libelle_fr) LIKE ? ESCAPE '\\')",
    );
    expect(params).toEqual(['%10\\%%', '%10\\%%', 10]);
  });

  test('un libellé NULL se replie sur le code', async () => {
    mockDeclaredField([{ value: '02013090', label: null }]);

    const result = await createSelectOptionsLoader('main').load({
      fieldName: 'nc8',
      limit: 10,
      searchTerm: null,
      labelField: 'nc8_libelle_en',
    });

    expect(result).toEqual([{ value: '02013090', label: '02013090' }]);
  });

  test('un nom de colonne de libellés invalide est rejeté avant toute requête', async () => {
    await expect(
      createSelectOptionsLoader('main').load({
        fieldName: 'nc8',
        limit: 10,
        searchTerm: null,
        labelField: 'x; DROP TABLE t',
      }),
    ).rejects.toThrow();
    expect(mockConnection.all).not.toHaveBeenCalled();
  });

  test('deux labelField différents → deux entrées de cache distinctes', async () => {
    mockConnection.all.mockResolvedValue([{ name: 'nc8' }] as never);
    const loader = createSelectOptionsLoader('main');

    await loader.load({
      fieldName: 'nc8',
      limit: 10,
      searchTerm: null,
      labelField: 'nc8_libelle_en',
    });
    await loader.load({
      fieldName: 'nc8',
      limit: 10,
      searchTerm: null,
      labelField: 'nc8_libelle_fr',
    });

    const keys = withCacheMock.mock.calls.map(([key]) => String(key));
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toContain('nc8_libelle_en');
    expect(keys[1]).toContain('nc8_libelle_fr');
  });
});

describe('SelectOptionsTreeLoader — libellés par niveau', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection.all.mockReset();
    mockDatabaseManager.getPool.mockReturnValue(mockPool);
    mockDatabaseManager.getDefaultSchema.mockReturnValue('main');
    mockPool.acquire.mockResolvedValue(mockConnection);
  });

  // Chaîne nc6 → nc8 : nc6 a un libellé, nc8 en a deux (en choisi par défaut)
  const TRADE_METADATA = [
    { name: 'nc6', parent_name: null, label_for: null },
    { name: 'nc6_libelle', parent_name: null, label_for: 'nc6' },
    { name: 'nc8', parent_name: 'nc6', label_for: null },
    { name: 'nc8_libelle_fr', parent_name: null, label_for: 'nc8' },
    { name: 'nc8_libelle_en', parent_name: null, label_for: 'nc8' },
  ];

  test('chaque niveau ajoute sa colonne de libellés au même DISTINCT', async () => {
    mockConnection.all.mockResolvedValueOnce(TRADE_METADATA as never).mockResolvedValueOnce([
      { nc6: '010129', _label_0: 'Chevaux', nc8: '01012910', _label_1: 'Horses for slaughter' },
      { nc6: '010129', _label_0: 'Chevaux', nc8: '01012990', _label_1: null },
    ] as never);

    const result = await createSelectOptionsTreeLoader('main').load({
      fieldName: 'nc8',
      maxDepth: null,
      searchTerm: 'slaughter',
      maxNodes: 100,
    });

    const [sql, params] = distinctCall();
    expect(sql).toContain(
      'SELECT DISTINCT nc6, nc6_libelle AS _label_0, nc8, nc8_libelle_en AS _label_1',
    );
    // Tri et recherche : codes de la chaîne, code ou libellé de la feuille
    expect(sql).toContain('ORDER BY nc6, nc8 LIMIT ?');
    expect(sql).toContain('OR LOWER(nc8_libelle_en) LIKE ?');
    expect(params).toEqual(['%slaughter%', '%slaughter%', 101]);
    expect(result).toEqual([
      {
        value: '010129',
        label: 'Chevaux',
        children: [
          { value: '01012910', label: 'Horses for slaughter' },
          { value: '01012990', label: '01012990' },
        ],
      },
    ]);
  });
});
