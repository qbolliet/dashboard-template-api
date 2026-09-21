/**
 * Unit tests for MetadataLoader (src/loaders/metadata.ts).
 *
 * Verifies metadata retrieval by field name, null return for unknown fields,
 * the snake_case → camelCase mapping applied by utils/metadata-mapping.ts, and
 * table qualification.
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

/** Ligne brute de la table metadata, en snake_case, booléens en entiers. */
interface MetadataRow {
  name: string;
  label?: string;
  sql_type?: string;
  is_categorical: number;
  is_primary_key: number;
  parent_name?: string | null;
  unit?: string | null;
  display_format?: string | null;
  family?: string | null;
  description?: string | null;
  default_aggregation?: string | null;
}

/** Métadonnée exposée par le loader — camelCase, booléens convertis. */
interface MetadataResult {
  name: string;
  label: string;
  sqlType: string;
  isCategorical: boolean;
  isPrimaryKey: boolean;
  parentName: string | null;
  unit: string | null;
  displayFormat: string | null;
  family: string | null;
  description: string | null;
  defaultAggregation: string | null;
}

/** Instance d'un loader DataLoader — interface minimale. */
interface DataLoaderInstance {
  load: (key: string) => Promise<MetadataResult | null>;
  clearAll: () => void;
}

/** Module metadata.ts après import dynamique. */
interface MetadataModule {
  createMetadataLoader: (databaseId?: string | null) => DataLoaderInstance;
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
let createMetadataLoader: MetadataModule['createMetadataLoader'];

beforeAll(async () => {
  ({ createMetadataLoader } =
    (await import('../../../src/loaders/metadata.js')) as unknown as MetadataModule);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MetadataLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDatabaseManager.getPool.mockReturnValue(mockPool);
    mockDatabaseManager.getDefaultSchema.mockReturnValue('main');
    mockPool.acquire.mockResolvedValue(mockConnection);
  });

  // ── Instanciation ─────────────────────────────────────────────────────────

  describe('createMetadataLoader', () => {
    test('crée un DataLoader avec le bon databaseId', () => {
      const loader = createMetadataLoader('analytics');
      expect(loader).toBeDefined();
      expect(typeof loader.load).toBe('function');
      expect(typeof loader.clearAll).toBe('function');
    });

    test('crée un DataLoader sans databaseId (null par défaut)', () => {
      const loader = createMetadataLoader();
      expect(loader).toBeDefined();
    });
  });

  // ── Chargement d'une métadonnée unique ────────────────────────────────────

  describe('loadSingle', () => {
    test('retourne les métadonnées pour un nom trouvé', async () => {
      const row: MetadataRow = {
        name: 'age',
        label: 'Âge',
        sql_type: 'INTEGER',
        is_categorical: 0,
        is_primary_key: 0,
        parent_name: null,
        unit: 'ans',
        display_format: ',.0f',
        family: 'Démographie',
        description: null,
        default_aggregation: 'AVG',
      };
      mockConnection.all.mockResolvedValue([row]);

      const loader = createMetadataLoader('main');
      const result = await loader.load('age');

      // Les onze colonnes remontent en camelCase, NULL compris
      expect(result).toEqual({
        name: 'age',
        label: 'Âge',
        sqlType: 'INTEGER',
        isCategorical: false,
        isPrimaryKey: false,
        parentName: null,
        unit: 'ans',
        displayFormat: ',.0f',
        family: 'Démographie',
        description: null,
        defaultAggregation: 'AVG',
      });
    });

    test("retourne null quand le champ n'est pas trouvé", async () => {
      mockConnection.all.mockResolvedValue([]);

      const loader = createMetadataLoader('main');
      const result = await loader.load('unknown_field');

      expect(result).toBeNull();
    });

    test('convertit is_categorical en isCategorical booléen', async () => {
      mockConnection.all.mockResolvedValue([
        {
          name: 'country',
          label: 'Country',
          sql_type: 'VARCHAR',
          is_categorical: 1,
          is_primary_key: 0,
        },
      ]);

      const loader = createMetadataLoader('main');
      const result = await loader.load('country');

      expect(result!.isCategorical).toBe(true);
      expect(result!.isPrimaryKey).toBe(false);
    });

    test('convertit is_primary_key en isPrimaryKey booléen', async () => {
      mockConnection.all.mockResolvedValue([
        {
          name: 'id',
          label: 'Id',
          sql_type: 'INTEGER',
          is_categorical: 0,
          is_primary_key: 1,
        },
      ]);

      const loader = createMetadataLoader('main');
      const result = await loader.load('id');

      expect(result!.isCategorical).toBe(false);
      expect(result!.isPrimaryKey).toBe(true);
    });

    test('projette explicitement les onze colonnes au lieu de SELECT *', async () => {
      mockConnection.all.mockResolvedValue([
        { name: 'field', is_categorical: 0, is_primary_key: 0 },
      ]);

      const loader = createMetadataLoader('main');
      await loader.load('field');

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).not.toContain('SELECT *');
      expect(query).toContain('default_aggregation');
      expect(query).toContain('parent_name');
    });

    test('utilise qualifyTable pour la table metadata', async () => {
      mockConnection.all.mockResolvedValue([
        { name: 'field', is_categorical: 0, is_primary_key: 0 },
      ]);

      const loader = createMetadataLoader('mydb');
      await loader.load('field');

      const query = mockConnection.all.mock.calls[0][0] as string;
      expect(query).toContain('"mydb"');
      expect(query).toContain('metadata');
    });
  });
});
