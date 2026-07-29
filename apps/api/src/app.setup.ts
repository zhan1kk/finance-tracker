import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { Express } from 'express';

/**
 * Imports post whole files in the JSON body — CSV statements as text and
 * spreadsheets as base64 — which do not fit Express's 100kb default. All such
 * routes are authenticated, and the parsers themselves cap what they will read.
 */
const BODY_LIMIT = '6mb';

/**
 * Express-level configuration shared by main.ts and the e2e test harness.
 * Module-level concerns (pipes, guards) live in AppModule providers.
 */
export function configureApp(app: INestApplication): void {
  const production = process.env.NODE_ENV === 'production';

  // The app is created with `bodyParser: false`, so these are the only body
  // parsers registered and their limit is the one that applies.
  const expressApp = app as NestExpressApplication;
  expressApp.useBodyParser('json', { limit: BODY_LIMIT });
  expressApp.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true });

  app.use(cookieParser());
  // CSP off outside production so the Swagger UI at /docs keeps working.
  app.use(helmet({ contentSecurityPolicy: production ? undefined : false }));

  if (production) {
    // Deployed behind a TLS-terminating reverse proxy (the API port itself is
    // not published): honor X-Forwarded-* for secure cookies and client IPs.
    (app.getHttpAdapter().getInstance() as Express).set('trust proxy', true);
  }
}
