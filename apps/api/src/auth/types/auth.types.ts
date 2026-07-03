export type JwtPayload = {
  sub: string;
  email: string;
};

export type AuthUser = {
  userId: string;
  email: string;
};

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
};
