import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { Express } from 'express';

/**
 * Express-level configuration shared by main.ts and the e2e test harness.
 * Module-level concerns (pipes, guards) live in AppModule providers.
 */
export function configureApp(app: INestApplication): void {
  const production = process.env.NODE_ENV === 'production';

  app.use(cookieParser());
  // CSP off outside production so the Swagger UI at /docs keeps working.
  app.use(helmet({ contentSecurityPolicy: production ? undefined : false }));

  if (production) {
    // Deployed behind a TLS-terminating reverse proxy (the API port itself is
    // not published): honor X-Forwarded-* for secure cookies and client IPs.
    (app.getHttpAdapter().getInstance() as Express).set('trust proxy', true);
  }
}
