import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';

/**
 * Express-level configuration shared by main.ts and the e2e test harness.
 * Module-level concerns (pipes, guards) live in AppModule providers.
 */
export function configureApp(app: INestApplication): void {
  app.use(cookieParser());
}
