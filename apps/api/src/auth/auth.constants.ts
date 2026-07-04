export const REFRESH_COOKIE = 'refresh_token';
// Path is '/' (not '/auth') because the web app proxies the API under a
// prefix (/api/auth/...), and a path-scoped cookie would not match there.
export const REFRESH_COOKIE_PATH = '/';
export const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_TTL_DAYS = 30;
