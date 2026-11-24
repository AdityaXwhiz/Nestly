export class ApiError extends Error {
  constructor(status, code, message, { requestId = null, details = {} } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

let inMemoryToken = typeof window !== 'undefined' ? sessionStorage.getItem('nestly_token') : null;
let sessionExpiredHandler = null;

export function getStoredToken() {
  return inMemoryToken;
}

export function setStoredToken(token) {
  inMemoryToken = token;
  if (typeof window !== 'undefined') {
    if (token) {
      sessionStorage.setItem('nestly_token', token);
    } else {
      sessionStorage.removeItem('nestly_token');
    }
  }
}

export function clearStoredToken() {
  inMemoryToken = null;
  if (typeof window !== 'undefined') {
    sessionStorage.removeItem('nestly_token');
  }
}

/**
 * Register a listener invoked when an authenticated request receives a 401 (Change #1).
 */
export function setOnSessionExpired(handler) {
  sessionExpiredHandler = handler;
}

const DEFAULT_BASE_URL = 'http://localhost:3000/api/v1';

export function getApiBaseUrl() {
  const envUrl = typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL;
  return (envUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * Centralized fetch wrapper for Nestly API.
 * - Handles JSON serialization/parsing
 * - Injects Bearer token when present
 * - Enforces request timeout with AbortController
 * - Maps backend error contracts { error: { code, message, requestId, details } } to ApiError
 * - Enforces Change #1: 401 redirects to session expired ONLY if the request carried a token
 */
export async function apiFetch(path, { timeoutMs = 10000, token: explicitToken, ...options } = {}) {
  const baseUrl = getApiBaseUrl();
  const url = path.startsWith('http') ? path : `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;

  const token = explicitToken !== undefined ? explicitToken : inMemoryToken;
  const hadToken = Boolean(token);

  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new ApiError(0, 'TIMEOUT', 'The request timed out. Please try again.');
    }
    throw new ApiError(0, 'NETWORK_ERROR', 'Unable to connect to Nestly. Please check your network connection.');
  } finally {
    clearTimeout(timeoutId);
  }

  // Parse response
  if (!response.ok) {
    let errorData = null;
    try {
      errorData = await response.json();
    } catch {
      // Body not JSON
    }

    const errorPayload = errorData?.error || {};
    const code = errorPayload.code || 'HTTP_ERROR';
    const message = errorPayload.message || response.statusText || 'An unexpected error occurred';
    const requestId = errorPayload.requestId || response.headers.get('x-request-id') || null;
    const details = errorPayload.details || {};

    // Change #1: Session expired redirect applies ONLY to requests that carried a token
    if (response.status === 401 && hadToken) {
      clearStoredToken();
      if (typeof sessionExpiredHandler === 'function') {
        sessionExpiredHandler({
          message: 'Your session has expired. Please sign in again.',
          code,
        });
      }
    }

    throw new ApiError(response.status, code, message, { requestId, details });
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}
