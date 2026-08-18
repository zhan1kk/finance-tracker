import type { User } from './types';

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type AuthResponse = { accessToken: string; user: User };

let refreshInFlight: Promise<User | null> | null = null;

/**
 * Exchanges the refresh cookie for a fresh access token. Null if not logged in.
 * Single-flight: refresh tokens rotate on use, so concurrent 401s (parallel
 * queries after token expiry) must share ONE request — a second one would use
 * the consumed cookie, fail, and clobber the fresh token.
 */
export function tryRefresh(): Promise<User | null> {
  refreshInFlight ??= doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh(): Promise<User | null> {
  const res = await fetch('/api/auth/refresh', { method: 'POST' });
  if (!res.ok) {
    setAccessToken(null);
    return null;
  }
  const data = (await res.json()) as AuthResponse;
  setAccessToken(data.accessToken);
  return data.user;
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
  allowRetry = true,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });

  // Access tokens are short-lived: on 401, refresh once and retry.
  if (res.status === 401 && allowRetry && !path.startsWith('/auth/')) {
    if (await tryRefresh()) {
      return api<T>(path, init, false);
    }
  }

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      message = Array.isArray(body.message)
        ? body.message.join('; ')
        : (body.message ?? message);
    } catch {
      // non-JSON error body; keep statusText
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

/** Downloads an authenticated file response (e.g. CSV export) as a browser download. */
export async function downloadFile(
  path: string,
  filename: string,
): Promise<void> {
  let res = await fetch(`/api${path}`, {
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
  if (res.status === 401 && (await tryRefresh())) {
    res = await fetch(`/api${path}`, {
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    });
  }
  if (!res.ok) {
    throw new ApiError(res.status, res.statusText);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function loginRequest(
  email: string,
  password: string,
): Promise<User> {
  const data = await api<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  setAccessToken(data.accessToken);
  return data.user;
}

export async function registerRequest(
  email: string,
  password: string,
  inviteCode?: string,
): Promise<User> {
  const data = await api<AuthResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(
      inviteCode ? { email, password, inviteCode } : { email, password },
    ),
  });
  setAccessToken(data.accessToken);
  return data.user;
}

export async function logoutRequest(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
  setAccessToken(null);
}

/**
 * Changes the password. Every session is revoked server-side, so the caller is
 * signed out here too and has to sign in again with the new password.
 */
export async function changePasswordRequest(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await api<void>('/auth/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  setAccessToken(null);
}
