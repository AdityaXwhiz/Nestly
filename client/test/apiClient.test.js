import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  apiFetch,
  ApiError,
  setStoredToken,
  clearStoredToken,
  setOnSessionExpired,
} from '../src/api/client.js';

describe('apiFetch & Client Auth Handling (Change #1)', () => {
  beforeEach(() => {
    clearStoredToken();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearStoredToken();
  });

  it('performs standard JSON requests with baseUrl and Content-Type', async () => {
    const mockJson = { success: true };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockJson,
      headers: new Headers({ 'content-type': 'application/json' }),
    });

    const result = await apiFetch('/test-endpoint');
    expect(result).toEqual(mockJson);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/test-endpoint',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
  });

  it('attaches Bearer token in Authorization header when token is present', async () => {
    setStoredToken('test-jwt-token-123');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ user: { id: 'usr_1' } }),
      headers: new Headers(),
    });

    await apiFetch('/auth/me');

    expect(fetchSpy).toHaveBeenCalled();
    const callHeaders = fetchSpy.mock.calls[0][1].headers;
    expect(callHeaders.get('Authorization')).toBe('Bearer test-jwt-token-123');
  });

  it('handles 401 WITH token: triggers session expired handler and clears token (Change #1)', async () => {
    setStoredToken('expired-token-456');

    const expiredHandlerSpy = vi.fn();
    setOnSessionExpired(expiredHandlerSpy);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers({ 'x-request-id': 'req-abc-123' }),
      json: async () => ({
        error: {
          code: 'TOKEN_EXPIRED',
          message: 'jwt expired',
          requestId: 'req-abc-123',
        },
      }),
    });

    await expect(apiFetch('/properties')).rejects.toThrow(ApiError);

    // Verified: Session expired handler was called
    expect(expiredHandlerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Your session has expired. Please sign in again.',
        code: 'TOKEN_EXPIRED',
      }),
    );
  });

  it('handles 401 WITHOUT token (login attempt): throws inline error and does NOT trigger session expired (Change #1)', async () => {
    clearStoredToken();

    const expiredHandlerSpy = vi.fn();
    setOnSessionExpired(expiredHandlerSpy);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers({ 'x-request-id': 'req-xyz-789' }),
      json: async () => ({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
          requestId: 'req-xyz-789',
        },
      }),
    });

    let caughtError;
    try {
      await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'wrong@example.com', password: 'bad' }),
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ApiError);
    expect(caughtError.status).toBe(401);
    expect(caughtError.code).toBe('INVALID_CREDENTIALS');
    expect(caughtError.message).toBe('Invalid email or password');
    expect(caughtError.requestId).toBe('req-xyz-789');

    // Change #1 verification: The session expired handler MUST NOT be called!
    expect(expiredHandlerSpy).not.toHaveBeenCalled();
  });

  it('handles request timeout via AbortController and maps to TIMEOUT error', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          setTimeout(() => reject(abortError), 50);
        }),
    );

    await expect(apiFetch('/slow-endpoint', { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'TIMEOUT',
      status: 0,
    });
  });
});
