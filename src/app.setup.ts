import type { INestApplication } from '@nestjs/common';
import { JsonLogger } from './infrastructure/observability/json-logger.js';
import { correlationIdMiddleware } from './infrastructure/observability/request-context.js';
import { httpMetricsMiddleware } from './infrastructure/observability/http-metrics.middleware.js';

/** Configuração transversal compartilhada por main.ts e pelos testes e2e. */
export function configureApp(app: INestApplication): INestApplication {
    app.useLogger(new JsonLogger());
    app.use(correlationIdMiddleware);
    app.use(httpMetricsMiddleware);
    // SIGTERM/SIGINT → onModuleDestroy dos workers (shutdown cooperativo).
    app.enableShutdownHooks();
    return app;
}
