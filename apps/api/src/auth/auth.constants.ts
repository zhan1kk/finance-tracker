export const REFRESH_COOKIE = 'refresh_token';
// Cookie is only sent to /auth/* endpoints (refresh + logout need it).
export const REFRESH_COOKIE_PATH = '/auth';
export const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_TTL_DAYS = 30;
