/**
 * Unit tests for logger and createContextLogger (src/utils/logger.ts).
 *
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 * Mocks winston and winston-daily-rotate-file to avoid file-system side-effects.
 * Verifies logger export and contextual log methods routing and metadata merging.
 */

import { jest } from '@jest/globals';

// ─── Interfaces ────────────────────────────────────────────────────────────────

/** Interface du logger Winston mocké exposant les quatre niveaux de log. */
interface MockWinstonLogger {
  info:  jest.Mock;
  debug: jest.Mock;
  warn:  jest.Mock;
  error: jest.Mock;
}

/** Forme minimale de la configuration requise par le module logger. */
interface MockConfig {
  ENVIRONMENT: string;
  LOGGING: {
    LEVEL:  string;
    FORMAT: string;
    TRANSPORTS: {
      console: { enabled: boolean };
      file:    { enabled: boolean; directory: string; filename: string; datePattern: string; maxSize: string; maxFiles: string; compress: boolean };
      error:   { enabled: boolean; directory: string; filename: string };
    };
    SAMPLING:     { enabled: boolean; rate: number };
    SANITIZATION: { fields: string[] };
    PERFORMANCE:  { SLOW_QUERY_THRESHOLD: number };
  };
}

/** Objet de format Winston retourné par les helpers de format mockés. */
interface MockFormatObj {
  transform: jest.Mock;
}

/** Fabrique de format Winston — callable et dotée de méthodes nommées. */
interface MockFormatCreator {
  (): () => MockFormatObj;
  timestamp: jest.Mock;
  errors:    jest.Mock;
  printf:    jest.Mock;
  combine:   jest.Mock;
  simple:    jest.Mock;
}

// ─── État mutable des mocks ───────────────────────────────────────────────────

const mockWinstonLogger: MockWinstonLogger = {
  info:  jest.fn(),
  debug: jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
};

const mockConfig: MockConfig = {
  ENVIRONMENT: 'development',
  LOGGING: {
    LEVEL:  'info',
    FORMAT: 'json',
    TRANSPORTS: {
      console: { enabled: true },
      file:    { enabled: false, directory: 'logs', filename: 'app-%DATE%.log', datePattern: 'YYYY-MM-DD', maxSize: '20m', maxFiles: '14d', compress: false },
      error:   { enabled: false, directory: 'logs', filename: 'error-%DATE%.log' },
    },
    SAMPLING:     { enabled: false, rate: 0.1 },
    SANITIZATION: { fields: ['password', 'token', 'secret'] },
    PERFORMANCE:  { SLOW_QUERY_THRESHOLD: 1000 },
  },
};

// ─── Mock du format Winston ───────────────────────────────────────────────────
// winston.format est à la fois callable (format(fn)()) et porteur de méthodes nommées.

const mockFormatObj: MockFormatObj = { transform: jest.fn() };
const mockFormatCreator = jest.fn().mockReturnValue(() => mockFormatObj) as unknown as MockFormatCreator;
mockFormatCreator.timestamp = jest.fn().mockReturnValue(mockFormatObj);
mockFormatCreator.errors    = jest.fn().mockReturnValue(mockFormatObj);
mockFormatCreator.printf    = jest.fn().mockReturnValue(mockFormatObj);
mockFormatCreator.combine   = jest.fn().mockReturnValue(mockFormatObj);
mockFormatCreator.simple    = jest.fn().mockReturnValue(mockFormatObj);

// ─── Enregistrement des mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../src/utils/config-loader.js', () => ({
  config: mockConfig,
}));

jest.unstable_mockModule('winston', () => ({
  default: {
    createLogger: jest.fn().mockReturnValue(mockWinstonLogger),
    format:       mockFormatCreator,
    transports:   { Console: jest.fn().mockImplementation(() => ({})) },
  },
}));

jest.unstable_mockModule('winston-daily-rotate-file', () => ({
  default: jest.fn().mockImplementation(() => ({})),
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

// Assertion d'assignation définitive — assignés dans beforeAll avant tout test.
let logger!: MockWinstonLogger;
let createContextLogger!: (context: Record<string, unknown>) => Record<string, (...args: unknown[]) => void>;

beforeAll(async () => {
  ({ logger, createContextLogger } = await import('../../../src/utils/logger.js') as {
    logger: MockWinstonLogger;
    createContextLogger: (context: Record<string, unknown>) => Record<string, (...args: unknown[]) => void>;
  });
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('logger export', () => {
  test('exports a logger object with logging methods', () => {
    expect(logger).toBeDefined();
    expect(logger).toBe(mockWinstonLogger);
  });
});

describe('createContextLogger', () => {
  test('returns an object with all expected methods', () => {
    const ctx = createContextLogger({ requestId: 'req-1' });
    expect(typeof ctx.operation).toBe('function');
    expect(typeof ctx.database).toBe('function');
    expect(typeof ctx.cache).toBe('function');
    expect(typeof ctx.performance).toBe('function');
    expect(typeof ctx.security).toBe('function');
    expect(typeof ctx.warn).toBe('function');
    expect(typeof ctx.error).toBe('function');
  });

  test('operation() calls logger.info with operation tag', () => {
    const ctx = createContextLogger({ requestId: 'r1' });
    ctx.operation('test message', { extra: 'data' });
    expect(mockWinstonLogger.info).toHaveBeenCalledWith(
      'test message',
      expect.objectContaining({ tags: expect.arrayContaining(['operation']) })
    );
  });

  test('database() calls logger.debug with database tag', () => {
    const ctx = createContextLogger({});
    ctx.database('db query executed');
    expect(mockWinstonLogger.debug).toHaveBeenCalledWith(
      'db query executed',
      expect.objectContaining({ tags: expect.arrayContaining(['database']) })
    );
  });

  test('cache() calls logger.debug with cache tag', () => {
    const ctx = createContextLogger({});
    ctx.cache('cache hit');
    expect(mockWinstonLogger.debug).toHaveBeenCalledWith(
      'cache hit',
      expect.objectContaining({ tags: expect.arrayContaining(['cache']) })
    );
  });

  test('performance() calls logger.info with performance tag and metrics', () => {
    // Métriques de performance — transmises dans un objet "metrics" dédié.
    const ctx = createContextLogger({});
    ctx.performance('slow query', { duration: 2000 });
    expect(mockWinstonLogger.info).toHaveBeenCalledWith(
      'slow query',
      expect.objectContaining({
        metrics: { duration: 2000 },
        tags: ['performance'],
      })
    );
  });

  test('security() calls logger.warn with security tag', () => {
    const ctx = createContextLogger({});
    ctx.security('suspicious request');
    expect(mockWinstonLogger.warn).toHaveBeenCalledWith(
      'suspicious request',
      expect.objectContaining({ tags: expect.arrayContaining(['security']) })
    );
  });

  test('warn() calls logger.warn with warning tag', () => {
    const ctx = createContextLogger({});
    ctx.warn('something unusual');
    expect(mockWinstonLogger.warn).toHaveBeenCalledWith(
      'something unusual',
      expect.objectContaining({ tags: expect.arrayContaining(['warning']) })
    );
  });

  test('error() calls logger.error with error tag and error object', () => {
    // Propagation de l'objet erreur — accessible via la clé "error" du contexte de log.
    const ctx = createContextLogger({});
    const err = new Error('boom');
    ctx.error('something failed', err);
    expect(mockWinstonLogger.error).toHaveBeenCalledWith(
      'something failed',
      expect.objectContaining({
        error: err,
        tags: expect.arrayContaining(['error']),
      })
    );
  });

  test('merges base context into every log call', () => {
    // Fusion du contexte de base — chaque appel de log hérite des métadonnées initiales.
    const base = { requestId: 'req-abc', operationName: 'getUsers' };
    const ctx = createContextLogger(base);
    ctx.operation('some op');
    expect(mockWinstonLogger.info).toHaveBeenCalledWith(
      'some op',
      expect.objectContaining({ requestId: 'req-abc', operationName: 'getUsers' })
    );
  });

  test('merges additional context into base context', () => {
    const ctx = createContextLogger({ requestId: 'r1' });
    ctx.database('query', { table: 'users' });
    expect(mockWinstonLogger.debug).toHaveBeenCalledWith(
      'query',
      expect.objectContaining({ requestId: 'r1', table: 'users' })
    );
  });

  test('each createContextLogger call is independent', () => {
    // Isolation des contextes — deux loggers créés séparément ne partagent pas d'état.
    const ctx1 = createContextLogger({ requestId: 'r1' });
    const ctx2 = createContextLogger({ requestId: 'r2' });
    ctx1.operation('msg1');
    ctx2.operation('msg2');
    const calls = mockWinstonLogger.info.mock.calls;
    expect(calls[0][1]).toMatchObject({ requestId: 'r1' });
    expect(calls[1][1]).toMatchObject({ requestId: 'r2' });
  });
});
