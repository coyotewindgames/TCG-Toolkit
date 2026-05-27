const BASE = import.meta.env.VITE_API_URL ?? '';

const DEV_USER = JSON.stringify({
  id: 'dev-1',
  storeId: 'store-1',
  role: 'clerk',
  email: 'dev@example.com',
});

let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (import.meta.env.DEV) {
    headers['x-tcg-dev-user'] = DEV_USER;
  }
  if (authToken) {
    headers['authorization'] = `Bearer ${authToken}`;
  }
  Object.assign(headers, (init?.headers ?? {}) as Record<string, string>);

  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T,>(p: string) => request<T>(p),
  post: <T,>(p: string, body: unknown) =>
    request<T>(p, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T,>(p: string, body: unknown) =>
    request<T>(p, { method: 'PATCH', body: JSON.stringify(body) }),
};
