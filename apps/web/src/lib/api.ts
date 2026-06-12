/**
 * Tenant-aware fetch wrapper for the React SPA.
 *
 * Auth strategy:
 *  1. If a real access token is in the session, attach `Authorization: Bearer`.
 *  2. Otherwise, in DEV-only, if `VITE_DEV_USER` is configured (a JSON object
 *     with id/storeId/role/email), attach the legacy `x-tcg-dev-user` header
 *     so the API's dev-mode auth shortcut accepts the request without a
 *     real login. The shortcut is rejected by the API in production.
 *  3. On a 401, attempt one silent `/auth/refresh` (which uses the HttpOnly
 *     refresh cookie) and replay the request once.
 *
 * The session is the single source of truth for `storeId`, `locationId`,
 * `registerId` — none of those are pulled from `import.meta.env` anymore.
 */
import {
  clearSession,
  getSession,
  oneHourFromNow,
  setAccessToken,
  setUser,
  type SessionUser,
} from './session';

const BASE = import.meta.env.VITE_API_URL ?? '';

function normalizedAccessToken(raw: string | null | undefined): string | null {
  const token = raw?.trim();
  return token ? token : null;
}

export interface FormUploadProgress {
  loaded: number;
  total: number | null;
  percent: number | null;
}

export interface PostFormOptions {
  onUploadProgress?: (progress: FormUploadProgress) => void;
}

class FormUploadNetworkError extends Error {
  uploadedBytes: number;

  constructor(message: string, uploadedBytes: number) {
    super(message);
    this.name = 'FormUploadNetworkError';
    this.uploadedBytes = uploadedBytes;
  }
}

async function sendFormWithXhr(args: {
  path: string;
  form: FormData;
  headers: Record<string, string>;
  onUploadProgress?: (progress: FormUploadProgress) => void;
}): Promise<{ status: number; bodyText: string }> {
  const { path, form, headers, onUploadProgress } = args;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let uploadedBytes = 0;
    xhr.open('POST', `${BASE}/api${path}`);
    xhr.withCredentials = true;

    Object.entries(headers).forEach(([key, value]) => {
      xhr.setRequestHeader(key, value);
    });

    xhr.upload.onprogress = (event) => {
      uploadedBytes = event.loaded;
      if (!onUploadProgress) return;
      const total = event.lengthComputable ? event.total : null;
      const percent = total && total > 0 ? Math.min(100, Math.round((event.loaded / total) * 100)) : null;
      onUploadProgress({ loaded: event.loaded, total, percent });
    };

    xhr.onload = () => {
      resolve({
        status: xhr.status,
        bodyText: xhr.responseText ?? '',
      });
    };

    xhr.onerror = () =>
      reject(
        new FormUploadNetworkError(
          'Network error while uploading form data.',
          uploadedBytes,
        ),
      );
    xhr.onabort = () => reject(new Error('Form upload was aborted.'));

    xhr.send(form);
  });
}

function parseJsonBody<T>(status: number, bodyText: string): T {
  if (status === 204) return undefined as T;
  if (!bodyText.trim()) return undefined as T;
  return JSON.parse(bodyText) as T;
}

function devHeader(): string | null {
  if (!import.meta.env.DEV) return null;
  const session = getSession();
  if (!session.user || session.accessToken) return null;
  // Dev fallback: synthesise the legacy header from the (dev-bootstrapped) session.
  return JSON.stringify({
    id: session.user.id,
    storeId: session.user.storeId,
    role: session.user.role,
    email: session.user.email,
    displayName: session.user.displayName,
  });
}

interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
  user: SessionUser;
}

/**
 * Calls `/api/auth/refresh` to mint a new access token from the HttpOnly
 * refresh cookie. Returns the new token on success, or null if the user has
 * no valid refresh cookie (logged out / expired).
 */
export async function refreshAccessToken(): Promise<string | null> {
  const res = await fetch(`${BASE}/api/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) return null;
  const body = (await res.json()) as RefreshResponse;
  setUser(body.user, body.accessToken, oneHourFromNow());
  return body.accessToken;
}

async function rawFetch<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  const session = getSession();
  const accessToken = normalizedAccessToken(session.accessToken);
  if (accessToken) {
    headers['authorization'] = `******;
  } else {
    const dev = devHeader();
    if (dev) headers['x-tcg-dev-user'] = dev;
  }
  Object.assign(headers, (init?.headers ?? {}) as Record<string, string>);

  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });

  if (res.status === 401 && !retried) {
    const fresh = await refreshAccessToken();
    if (fresh) return rawFetch<T>(path, init, true);
    clearSession();
  }
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`API ${res.status}: ${body}`) as Error & { status?: number; body?: string };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T,>(p: string) => rawFetch<T>(p),
  getBlob: async (p: string): Promise<Blob> => {
    const headers: Record<string, string> = {};
    const session = getSession();
    const accessToken = normalizedAccessToken(session.accessToken);
    if (accessToken) {
      headers['authorization'] = `******;
    } else {
      const dev = devHeader();
      if (dev) headers['x-tcg-dev-user'] = dev;
    }

    const send = async (): Promise<Response> =>
      fetch(`${BASE}/api${p}`, {
        method: 'GET',
        credentials: 'include',
        headers,
      });

    let res = await send();
    if (res.status === 401) {
      const fresh = await refreshAccessToken();
      if (fresh) {
        res = await send();
      } else {
        clearSession();
      }
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${res.status}: ${text}`);
    }
    return res.blob();
  },
  post: <T,>(p: string, body: unknown) =>
    rawFetch<T>(p, { method: 'POST', body: JSON.stringify(body) }),
  put: <T,>(p: string, body: unknown) =>
    rawFetch<T>(p, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T,>(p: string, body: unknown) =>
    rawFetch<T>(p, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T,>(p: string) => rawFetch<T>(p, { method: 'DELETE' }),
  /**
   * POST that returns the raw response body as a Blob (for PDF downloads
   * etc.). Reuses the same auth headers as `rawFetch` but doesn't try to
   * parse JSON.
   */
  postBlob: async (p: string, body: unknown): Promise<Blob> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const session = getSession();
    const accessToken = normalizedAccessToken(session.accessToken);
    if (accessToken) {
      headers['authorization'] = `******;
    } else {
      const dev = devHeader();
      if (dev) headers['x-tcg-dev-user'] = dev;
    }
    const res = await fetch(`${BASE}/api${p}`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${res.status}: ${text}`);
    }
    return res.blob();
  },
  /**
   * Multipart/form-data upload with the same auth + refresh behavior as JSON
   * requests. Used for large file imports where JSON payloads can exceed
   * gateway limits.
   */
  postForm: async <T,>(p: string, form: FormData, options?: PostFormOptions): Promise<T> => {
    console.info('[api] postForm called', {
      path: p,
      formDataKeys: Array.from(form.keys()),
    });

    // Log form fields (excluding large binary data)
    const logFormData: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      if (value instanceof File) {
        logFormData[key] = {
          type: 'File',
          name: value.name,
          size: value.size,
          mimeType: value.type,
        };
      } else {
        logFormData[key] = value;
      }
    }
    console.info('[api] postForm data', logFormData);

    const sendOnce = async (): Promise<{ status: number; bodyText: string }> => {
      const headers: Record<string, string> = {};
      const session = getSession();
      const accessToken = normalizedAccessToken(session.accessToken);
      if (accessToken) {
        headers['authorization'] = `******;
      } else {
        const dev = devHeader();
        if (dev) headers['x-tcg-dev-user'] = dev;
      }

      if (options?.onUploadProgress) {
        return sendFormWithXhr({
          path: p,
          form,
          headers,
          onUploadProgress: options.onUploadProgress,
        });
      }

      const res = await fetch(`${BASE}/api${p}`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: form,
      });
      return {
        status: res.status,
        bodyText: await res.text(),
      };
    };

    const send = async (): Promise<{ status: number; bodyText: string }> => {
      try {
        return await sendOnce();
      } catch (error) {
        console.error('[api] postForm error during send', error);
        if (error instanceof FormUploadNetworkError && error.uploadedBytes === 0) {
          // Safe retry: request did not begin sending payload bytes.
          console.info('[api] postForm retrying after network error (0 bytes sent)');
          return sendOnce();
        }
        throw error;
      }
    };

    let res = await send();
    console.info('[api] postForm initial response', {
      status: res.status,
      bodyPreview: res.bodyText.slice(0, 500),
    });

    if (res.status === 401) {
      console.info('[api] postForm received 401, attempting token refresh');
      const fresh = await refreshAccessToken();
      if (fresh) {
        console.info('[api] postForm token refreshed, retrying request');
        res = await send();
        console.info('[api] postForm retry response', {
          status: res.status,
          bodyPreview: res.bodyText.slice(0, 500),
        });
      } else {
        console.error('[api] postForm refresh failed, clearing session');
        clearSession();
      }
    }

    if (res.status < 200 || res.status >= 300) {
      console.error('[api] postForm request failed', {
        status: res.status,
        body: res.bodyText,
      });
      throw new Error(`API ${res.status}: ${res.bodyText}`);
    }

    const parsed = parseJsonBody<T>(res.status, res.bodyText);
    console.info('[api] postForm success', {
      status: res.status,
      resultKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : 'not an object',
    });

    return parsed;
  },
};

/**
 * Login with email/password. Persists the resulting access token + user
 * into the global session.
 */
export async function login(email: string, password: string): Promise<SessionUser> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Login failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as RefreshResponse;
  setUser(data.user, data.accessToken, oneHourFromNow());
  return data.user;
}

export interface SignupInput {
  storeName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
  timezone?: string;
}

export interface SignupResult {
  accessToken: string;
  user: SessionUser;
  store: { id: string; name: string };
  location: { id: string; name: string };
}

export async function signup(input: SignupInput): Promise<SignupResult> {
  const res = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Signup failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as SignupResult & { expiresIn: number };
  setUser(data.user, data.accessToken, oneHourFromNow());
  return data;
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${BASE}/api/auth/logout`, { method: 'POST', credentials: 'include' });
  } finally {
    clearSession();
    setAccessToken(null);
  }
}

/**
 * Triggers a password-reset email. The server always returns 204 regardless
 * of whether the email matched a user (anti-enumeration), so a successful
 * resolution does NOT confirm the address exists.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/forgot-password`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.text();
    throw new Error(`Reset request failed (${res.status}): ${body}`);
  }
}

export async function confirmPasswordReset(token: string, password: string): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/reset-password`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password }),
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.text();
    throw new Error(`Reset failed (${res.status}): ${body}`);
  }
}
