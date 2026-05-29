/**
 * Unit tests for ConfigLoader (src/utils/config-loader.ts).
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 * Mocks the fs and yaml modules to avoid disk I/O.
 * Covers module load, mergeDeep, resolveEnvVariables, applyEnvironmentSpecific,
 * convertNumericValues, validateEnvironment, validateRequiredFields, and get.
 */

import { jest } from '@jest/globals';

// ─── Interfaces ────────────────────────────────────────────────────────────────

/** Configuration minimale valide — satisfait toutes les validations requises. */
interface ValidConfig {
  ENVIRONMENT: string;
  API: { PORT: number; TIMEOUTS: { CACHE_DEFAULT: number } };
  CATALOG_ROUTING: {
    DEFAULT_CATALOG: string;
    ALLOWED_CATALOGS: string[];
  };
  DATABASE: { POOL: { MAX_CONNECTIONS: number } };
  SECURITY: { RATE_LIMIT: { MAX_REQUESTS: number } };
  CATALOGS: Record<string, unknown>;
}

/** Interface publique de l'instance ConfigLoader exposée par le module. */
interface ConfigLoaderInstance {
  config: Record<string, unknown> | null;
  loadConfig: () => Record<string, unknown>;
  mergeDeep: (
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ) => Record<string, unknown>;
  resolveEnvVariables: (value: unknown) => unknown;
  applyEnvironmentSpecific: (cfg: Record<string, unknown>) => Record<string, unknown>;
  convertNumericValues: (value: unknown) => unknown;
  validateEnvironment: (cfg: Record<string, unknown>) => void;
  validateRequiredFields: (cfg: Record<string, unknown>) => void;
  get: (path: string, defaultValue?: unknown) => unknown;
}

// ─── Configuration valide minimale ────────────────────────────────────────────

const validConfig: ValidConfig = {
  ENVIRONMENT: 'development',
  API: { PORT: 4000, TIMEOUTS: { CACHE_DEFAULT: 300 } },
  CATALOG_ROUTING: {
    DEFAULT_CATALOG: 'main',
    ALLOWED_CATALOGS: ['main', 'analytics'],
  },
  DATABASE: { POOL: { MAX_CONNECTIONS: 5 } },
  SECURITY: { RATE_LIMIT: { MAX_REQUESTS: 100 } },
  CATALOGS: { main: {} },
};

// ─── Fonctions mock mutables ──────────────────────────────────────────────────

const mockFsExistsSync = jest.fn().mockReturnValue(true);
const mockFsReadFile = jest.fn().mockReturnValue('mocked: yaml');
const mockYamlParse = jest.fn().mockReturnValue(validConfig);

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('fs', () => ({
  default: { existsSync: mockFsExistsSync, readFileSync: mockFsReadFile },
  existsSync: mockFsExistsSync,
  readFileSync: mockFsReadFile,
}));

jest.unstable_mockModule('yaml', () => ({
  default: { parse: mockYamlParse },
  parse: mockYamlParse,
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Assertion d'assignation définitive — assignés dans beforeAll avant tout test.
let configLoader!: ConfigLoaderInstance;
let config!: ValidConfig;

beforeAll(async () => {
  ({ configLoader, config } = (await import('../../../src/utils/config-loader.js')) as {
    configLoader: ConfigLoaderInstance;
    config: ValidConfig;
  });
});

// ─── Chargement du module ─────────────────────────────────────────────────────

describe('ConfigLoader – module load', () => {
  test('exports a loaded config object', () => {
    expect(config).toBeDefined();
    expect(config.ENVIRONMENT).toMatch(/^(development|production)$/);
  });

  test('exports a configLoader instance with expected methods', () => {
    expect(configLoader).toBeDefined();
    expect(typeof configLoader.get).toBe('function');
    expect(typeof configLoader.loadConfig).toBe('function');
  });

  test('config has CATALOG_ROUTING with required keys', () => {
    expect(config.CATALOG_ROUTING).toBeDefined();
    expect(config.CATALOG_ROUTING.DEFAULT_CATALOG).toBeDefined();
    expect(Array.isArray(config.CATALOG_ROUTING.ALLOWED_CATALOGS)).toBe(true);
  });

  test('loadConfig returns the same object on repeated calls (cached)', () => {
    // Mise en cache interne — deux appels successifs retournent la même référence.
    const first = configLoader.loadConfig();
    const second = configLoader.loadConfig();
    expect(first).toBe(second);
  });
});

// ─── mergeDeep ────────────────────────────────────────────────────────────────

describe('ConfigLoader – mergeDeep', () => {
  test('merges nested objects deeply', () => {
    const target = { a: { b: 1, c: 2 }, d: 3 };
    const source = { a: { b: 4, e: 5 }, f: 6 };
    expect(configLoader.mergeDeep(target, source)).toEqual({
      a: { b: 4, c: 2, e: 5 },
      d: 3,
      f: 6,
    });
  });

  test('replaces arrays instead of merging them', () => {
    // Remplacement des tableaux — pas de concaténation, la source écrase la cible.
    const target = { items: [1, 2, 3] };
    const source = { items: [4, 5] };
    expect(configLoader.mergeDeep(target, source).items).toEqual([4, 5]);
  });

  test('adds source key absent from target', () => {
    const target = { a: 1 };
    const source = { b: { nested: true } };
    expect(configLoader.mergeDeep(target, source)).toEqual({
      a: 1,
      b: { nested: true },
    });
  });

  test('handles null values in source', () => {
    const target = { a: 1, b: 2 };
    const source = { b: null, c: null };
    expect(configLoader.mergeDeep(target, source)).toEqual({ a: 1, b: null, c: null });
  });

  test('does not mutate the target object', () => {
    // Immutabilité — la cible ne doit pas être modifiée en place.
    const target = { a: { b: 1 } };
    const source = { a: { c: 2 } };
    const originalTarget = JSON.parse(JSON.stringify(target));
    configLoader.mergeDeep(target, source);
    expect(target).toEqual(originalTarget);
  });
});

// ─── resolveEnvVariables ──────────────────────────────────────────────────────

describe('ConfigLoader – resolveEnvVariables', () => {
  test('resolves an environment variable', () => {
    process.env.CL_TEST_VAR = 'resolved_value';
    expect(configLoader.resolveEnvVariables('${CL_TEST_VAR}')).toBe('resolved_value');
    delete process.env.CL_TEST_VAR;
  });

  test('uses default value when env var is not set', () => {
    // Valeur par défaut — utilisée quand la variable d'environnement est absente.
    expect(configLoader.resolveEnvVariables('${CL_UNDEF_VAR:-my_default}')).toBe('my_default');
  });

  test('keeps the placeholder when no env var and no default', () => {
    // Conservation du placeholder — pas de substitution si aucune valeur disponible.
    expect(configLoader.resolveEnvVariables('${CL_NO_DEFAULT}')).toBe('${CL_NO_DEFAULT}');
  });

  test('substitutes multiple variables in a string', () => {
    // Substitutions multiples — plusieurs variables dans une même chaîne.
    process.env.CL_HOST = 'localhost';
    process.env.CL_PORT = '5432';
    const result = configLoader.resolveEnvVariables('${CL_HOST}:${CL_PORT}');
    expect(result).toBe('localhost:5432');
    delete process.env.CL_HOST;
    delete process.env.CL_PORT;
  });

  test('recursively resolves in nested objects', () => {
    process.env.CL_DB_HOST = 'db.example.com';
    const result = configLoader.resolveEnvVariables({
      database: { host: '${CL_DB_HOST}', port: '${CL_DB_PORT:-5432}' },
    }) as { database: { host: string; port: string } };
    expect(result.database.host).toBe('db.example.com');
    expect(result.database.port).toBe('5432');
    delete process.env.CL_DB_HOST;
  });

  test('recursively resolves in arrays', () => {
    process.env.CL_ITEM = 'item_value';
    const result = configLoader.resolveEnvVariables(['${CL_ITEM}', 'static']);
    expect(result).toEqual(['item_value', 'static']);
    delete process.env.CL_ITEM;
  });

  test('passes non-string primitives through unchanged', () => {
    // Primitives non-string — retournées telles quelles sans transformation.
    expect(configLoader.resolveEnvVariables(42)).toBe(42);
    expect(configLoader.resolveEnvVariables(true)).toBe(true);
    expect(configLoader.resolveEnvVariables(null)).toBe(null);
  });
});

// ─── applyEnvironmentSpecific ─────────────────────────────────────────────────

describe('ConfigLoader – applyEnvironmentSpecific', () => {
  test('selects development values for development env', () => {
    const cfg = {
      ENVIRONMENT: 'development',
      feature: {
        development: { debug: true },
        production: { debug: false },
      },
    };
    const result = configLoader.applyEnvironmentSpecific(cfg);
    expect(result.feature).toEqual({ debug: true });
  });

  test('selects production values for production env', () => {
    const cfg = {
      ENVIRONMENT: 'production',
      feature: {
        development: { debug: true },
        production: { debug: false },
      },
    };
    const result = configLoader.applyEnvironmentSpecific(cfg);
    expect(result.feature).toEqual({ debug: false });
  });

  test('falls back to development when env value is missing', () => {
    // Repli sur "development" — environnement inconnu (ex. "staging") traité comme dev.
    const cfg = {
      ENVIRONMENT: 'staging',
      feature: {
        development: { value: 'dev_value' },
        production: { value: 'prod_value' },
      },
    };
    const result = configLoader.applyEnvironmentSpecific(cfg);
    expect(result.feature).toEqual({ value: 'dev_value' });
  });

  test('merges common with env-specific arrays', () => {
    // Fusion des tableaux "common" et de l'environnement spécifique.
    const cfg = {
      ENVIRONMENT: 'production',
      patterns: {
        common: { list: ['a', 'b'] },
        production: { list: ['c'] },
        development: { list: ['d'] },
      },
    };
    const result = configLoader.applyEnvironmentSpecific(cfg);
    expect((result.patterns as { list: string[] }).list).toEqual(['a', 'b', 'c']);
  });

  test('applies recursively to nested objects', () => {
    const cfg = {
      ENVIRONMENT: 'development',
      top: {
        nested: {
          development: { flag: 'yes' },
          production: { flag: 'no' },
        },
      },
    };
    const result = configLoader.applyEnvironmentSpecific(cfg);
    expect((result.top as { nested: unknown }).nested).toEqual({ flag: 'yes' });
  });

  test('returns non-object values unchanged', () => {
    // Primitives — retournées sans transformation par la résolution d'environnement.
    const cfg = {
      ENVIRONMENT: 'development',
      count: 42,
      label: 'hello',
    };
    const result = configLoader.applyEnvironmentSpecific(cfg);
    expect(result.count).toBe(42);
    expect(result.label).toBe('hello');
  });
});

// ─── convertNumericValues ─────────────────────────────────────────────────────

describe('ConfigLoader – convertNumericValues', () => {
  test('converts integer strings to numbers', () => {
    const result = configLoader.convertNumericValues({ port: '3000', timeout: '5000' }) as Record<
      string,
      unknown
    >;
    expect(result.port).toBe(3000);
    expect(result.timeout).toBe(5000);
  });

  test('converts negative integer strings', () => {
    expect(configLoader.convertNumericValues({ offset: '-10' })).toEqual({ offset: -10 });
  });

  test('converts float strings to numbers', () => {
    const result = configLoader.convertNumericValues({ ratio: '3.14', pct: '99.9' }) as Record<
      string,
      unknown
    >;
    expect(result.ratio).toBe(3.14);
    expect(result.pct).toBe(99.9);
  });

  test('converts "true" and "false" strings to booleans', () => {
    const result = configLoader.convertNumericValues({ on: 'true', off: 'false' }) as Record<
      string,
      unknown
    >;
    expect(result.on).toBe(true);
    expect(result.off).toBe(false);
  });

  test('preserves non-numeric strings', () => {
    // Conservation des chaînes non numériques — pas de conversion parasite.
    const result = configLoader.convertNumericValues({
      name: 'service',
      ip: '192.168.1.1',
      mixed: '123abc',
    }) as Record<string, unknown>;
    expect(result.name).toBe('service');
    expect(result.ip).toBe('192.168.1.1');
    expect(result.mixed).toBe('123abc');
  });

  test('handles nested objects', () => {
    const result = configLoader.convertNumericValues({
      db: { port: '5432', connections: '10' },
    }) as { db: Record<string, unknown> };
    expect(result.db.port).toBe(5432);
    expect(result.db.connections).toBe(10);
  });

  test('handles arrays', () => {
    const result = configLoader.convertNumericValues({ ids: ['1', '2', 'abc'] }) as {
      ids: unknown[];
    };
    expect(result.ids).toEqual([1, 2, 'abc']);
  });

  test('preserves actual numbers and booleans unchanged', () => {
    // Valeurs déjà typées — pas de double conversion.
    const result = configLoader.convertNumericValues({ port: 4000, flag: true }) as Record<
      string,
      unknown
    >;
    expect(result.port).toBe(4000);
    expect(result.flag).toBe(true);
  });
});

// ─── validateEnvironment ──────────────────────────────────────────────────────

describe('ConfigLoader – validateEnvironment', () => {
  test('accepts "development"', () => {
    expect(() => configLoader.validateEnvironment({ ENVIRONMENT: 'development' })).not.toThrow();
  });

  test('accepts "production"', () => {
    expect(() => configLoader.validateEnvironment({ ENVIRONMENT: 'production' })).not.toThrow();
  });

  test('rejects an unknown environment string', () => {
    expect(() => configLoader.validateEnvironment({ ENVIRONMENT: 'staging' })).toThrow(
      'Invalid environment',
    );
  });

  test('rejects missing ENVIRONMENT key', () => {
    expect(() => configLoader.validateEnvironment({})).toThrow('Invalid environment');
  });
});

// ─── validateRequiredFields ───────────────────────────────────────────────────

describe('ConfigLoader – validateRequiredFields', () => {
  // Configuration de base complète — sert de référence pour les tests de champs manquants.
  const base: Record<string, unknown> = {
    API: { PORT: 4000 },
    CATALOG_ROUTING: { DEFAULT_CATALOG: 'main', ALLOWED_CATALOGS: ['main'] },
    DATABASE: { POOL: { MAX_CONNECTIONS: 5 } },
    SECURITY: { RATE_LIMIT: { MAX_REQUESTS: 100 } },
    CATALOGS: { main: {} },
  };

  test('passes with all required fields present', () => {
    expect(() => configLoader.validateRequiredFields(base)).not.toThrow();
  });

  test('throws when API.PORT is missing', () => {
    expect(() => configLoader.validateRequiredFields({ ...base, API: {} })).toThrow(
      'Missing required configuration',
    );
  });

  test('throws when CATALOG_ROUTING.DEFAULT_CATALOG is missing', () => {
    expect(() =>
      configLoader.validateRequiredFields({
        ...base,
        CATALOG_ROUTING: { ALLOWED_CATALOGS: ['main'] },
      }),
    ).toThrow('Missing required configuration');
  });

  test('throws when CATALOG_ROUTING.ALLOWED_CATALOGS is missing', () => {
    expect(() =>
      configLoader.validateRequiredFields({
        ...base,
        CATALOG_ROUTING: { DEFAULT_CATALOG: 'main' },
      }),
    ).toThrow('Missing required configuration');
  });

  test('throws when SECURITY.RATE_LIMIT.MAX_REQUESTS is missing', () => {
    expect(() => configLoader.validateRequiredFields({ ...base, SECURITY: {} })).toThrow(
      'Missing required configuration',
    );
  });

  test('throws when CATALOGS is an empty object', () => {
    expect(() => configLoader.validateRequiredFields({ ...base, CATALOGS: {} })).toThrow(
      'No catalogs configured',
    );
  });

  test('throws when CATALOGS is missing', () => {
    const { CATALOGS: _removed, ...rest } = base;
    expect(() => configLoader.validateRequiredFields(rest)).toThrow('No catalogs configured');
  });
});

// ─── get ──────────────────────────────────────────────────────────────────────

describe('ConfigLoader – get', () => {
  let savedConfig: Record<string, unknown> | null;

  beforeAll(() => {
    savedConfig = configLoader.config;
  });

  beforeEach(() => {
    configLoader.config = {
      database: {
        host: 'localhost',
        port: 5432,
        ssl: { enabled: true },
      },
      features: ['auth', 'cache'],
    };
  });

  afterEach(() => {
    configLoader.config = savedConfig;
  });

  test('retrieves a top-level value', () => {
    expect(configLoader.get('features')).toEqual(['auth', 'cache']);
  });

  test('retrieves a nested value via dot notation', () => {
    // Notation pointée — accès aux valeurs imbriquées via des chemins segmentés.
    expect(configLoader.get('database.host')).toBe('localhost');
    expect(configLoader.get('database.ssl.enabled')).toBe(true);
  });

  test('returns null by default for missing keys', () => {
    expect(configLoader.get('missing')).toBe(null);
    expect(configLoader.get('database.missing')).toBe(null);
  });

  test('returns the provided default for missing keys', () => {
    expect(configLoader.get('missing.key', 'fallback')).toBe('fallback');
  });

  test('returns 0 and false values (not treated as missing)', () => {
    // Valeurs falsy — 0 et false ne doivent pas déclencher le retour de la valeur par défaut.
    configLoader.config = { num: 0, flag: false };
    expect(configLoader.get('num')).toBe(0);
    expect(configLoader.get('flag')).toBe(false);
  });
});

// ─── loadConfig — réinitialisation du cache ───────────────────────────────────

describe('ConfigLoader – loadConfig cache reset', () => {
  let savedConfig: Record<string, unknown> | null;

  beforeAll(() => {
    savedConfig = configLoader.config;
  });

  afterEach(() => {
    configLoader.config = savedConfig;
  });

  test('re-loads when config is nulled manually', () => {
    // Réinitialisation manuelle — la mise à null force un rechargement depuis les fichiers.
    configLoader.config = null;
    const reloaded = configLoader.loadConfig();
    expect(reloaded).toBeDefined();
    expect((reloaded as ValidConfig).CATALOG_ROUTING).toBeDefined();
  });

  test('result of re-load is then cached again', () => {
    configLoader.config = null;
    const first = configLoader.loadConfig();
    const second = configLoader.loadConfig();
    expect(first).toBe(second);
  });
});
