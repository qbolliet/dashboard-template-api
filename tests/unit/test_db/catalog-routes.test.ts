/**
 * Unit tests for catalog-routes.js (src/db/catalog-routes.js).
 *
 * Verifies registration of POST /api/catalog/reload, that it is guarded by the
 * shared requireAdminKey middleware, and that the handler delegates to
 * databaseManager.reloadCatalogs with proper success / error responses.
 * Uses jest.unstable_mockModule + dynamic imports for ESM compatibility.
 */

import { jest } from '@jest/globals';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Gestionnaire de base de données mocké — seule reloadCatalogs est utilisée. */
interface MockDatabaseManager {
  reloadCatalogs: jest.Mock;
}

/** Application Express mockée — enregistrement des routes POST. */
interface MockApp {
  post: jest.Mock;
  get: jest.Mock;
}

/** Réponse HTTP mockée — simulation de res.status().json(). */
interface MockResponse {
  status: jest.Mock;
  json: jest.Mock;
}

/** Requête HTTP mockée. */
interface MockRequest {
  headers: Record<string, string>;
  params: Record<string, string>;
}

/** Module catalog-routes.js après import dynamique. */
interface CatalogRoutesModule {
  createCatalogRoutes: (app: MockApp) => void;
}

// ─── État des mocks ───────────────────────────────────────────────────────────

// Gestionnaire de base de données mocké — référence stable réutilisée par les tests
const mockDatabaseManager: MockDatabaseManager = {
  reloadCatalogs: jest.fn(),
};

// Middleware d'authentification mocké — laisse passer en appelant next()
const mockRequireAdminKey = jest.fn((_req: MockRequest, _res: MockResponse, next: jest.Mock) =>
  next(),
);

// ─── Enregistrement des mocks (avant tout import dynamique) ───────────────────

jest.unstable_mockModule('../../../src/db/index.js', () => ({
  databaseManager: mockDatabaseManager,
}));

jest.unstable_mockModule('../../../src/security/admin-auth.js', () => ({
  requireAdminKey: mockRequireAdminKey,
}));

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  createContextLogger: () => ({
    database: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// ─── Import dynamique ─────────────────────────────────────────────────────────

let createCatalogRoutes: (app: MockApp) => void;

beforeAll(async () => {
  ({ createCatalogRoutes } =
    (await import('../../../src/db/catalog-routes.js')) as unknown as CatalogRoutesModule);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createCatalogRoutes', () => {
  let mockApp: MockApp;

  const makeReq = (overrides: Partial<MockRequest> = {}): MockRequest => ({
    params: {},
    headers: {},
    ...overrides,
  });
  const makeRes = (): MockResponse => {
    const res = { status: jest.fn(), json: jest.fn() } as MockResponse;
    (res.status as jest.Mock).mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockApp = { post: jest.fn(), get: jest.fn() };
    createCatalogRoutes(mockApp);
  });

  // ── Enregistrement de la route ────────────────────────────────────────────

  describe('route registration', () => {
    test('registers POST /api/catalog/reload', () => {
      const paths: string[] = mockApp.post.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(paths).toContain('/api/catalog/reload');
    });

    test('guards the route with the shared requireAdminKey middleware', () => {
      const call = mockApp.post.mock.calls.find((c: unknown[]) => c[0] === '/api/catalog/reload');
      expect(call![1]).toBe(mockRequireAdminKey);
    });
  });

  // ── Handler POST /api/catalog/reload ──────────────────────────────────────

  describe('POST /api/catalog/reload handler', () => {
    let handler: (req: MockRequest, res: MockResponse) => Promise<void>;

    beforeEach(() => {
      const call = mockApp.post.mock.calls.find((c: unknown[]) => c[0] === '/api/catalog/reload');
      handler = call![2] as typeof handler;
    });

    test('delegates to databaseManager.reloadCatalogs and returns success', async () => {
      mockDatabaseManager.reloadCatalogs.mockResolvedValueOnce(undefined);
      const res = makeRes();

      await handler(makeReq(), res);

      expect(mockDatabaseManager.reloadCatalogs).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, timestamp: expect.any(String) }),
      );
    });

    test('returns 500 with the error message on reload failure', async () => {
      mockDatabaseManager.reloadCatalogs.mockRejectedValueOnce(new Error('S3 unreachable'));
      const res = makeRes();

      await handler(makeReq(), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'S3 unreachable' }));
    });
  });
});
