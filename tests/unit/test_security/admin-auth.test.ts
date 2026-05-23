/**
 * Unit tests for admin-auth.js (src/security/admin-auth.js).
 *
 * Verifies the requireAdminKey Express middleware: fail-safe 503 when
 * ADMIN_API_KEY is unset, 401 on missing/invalid x-admin-key header, and
 * next() when the header matches. Uses jest.unstable_mockModule + dynamic
 * imports for ESM compatibility.
 */

import { jest } from '@jest/globals';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Réponse HTTP mockée — simulation de res.status().json(). */
interface MockResponse {
  status: jest.Mock;
  json: jest.Mock;
}

/** Requête HTTP mockée — simulation de req.headers. */
interface MockRequest {
  headers: Record<string, string>;
}

/** Module admin-auth.js après import dynamique. */
interface AdminAuthModule {
  requireAdminKey: (req: MockRequest, res: MockResponse, next: jest.Mock) => void;
}

// ─── Import dynamique ─────────────────────────────────────────────────────────

let requireAdminKey: (req: MockRequest, res: MockResponse, next: jest.Mock) => void;

beforeAll(async () => {
  ({ requireAdminKey } =
    (await import('../../../src/security/admin-auth.js')) as unknown as AdminAuthModule);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('requireAdminKey middleware', () => {
  const next: jest.Mock = jest.fn();

  // Constructeurs de stubs légers pour req et res
  const makeReq = (headers: Record<string, string> = {}): MockRequest => ({ headers });
  const makeRes = (): MockResponse => {
    const res = { status: jest.fn(), json: jest.fn() } as MockResponse;
    (res.status as jest.Mock).mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.ADMIN_API_KEY;
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  test('returns 503 when ADMIN_API_KEY env var is not set', () => {
    const res = makeRes();
    requireAdminKey(makeReq(), res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 when x-admin-key header is absent', () => {
    process.env.ADMIN_API_KEY = 'secret';
    const res = makeRes();
    requireAdminKey(makeReq({}), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 when x-admin-key is wrong', () => {
    process.env.ADMIN_API_KEY = 'secret';
    const res = makeRes();
    requireAdminKey(makeReq({ 'x-admin-key': 'wrong' }), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next() when x-admin-key matches ADMIN_API_KEY', () => {
    process.env.ADMIN_API_KEY = 'secret';
    const res = makeRes();
    requireAdminKey(makeReq({ 'x-admin-key': 'secret' }), res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
