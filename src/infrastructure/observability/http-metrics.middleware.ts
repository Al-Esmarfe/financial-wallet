import { metrics } from './metrics.js';

interface MinimalRequest {
    method: string;
    route?: { path?: string };
}
interface MinimalResponse {
    statusCode: number;
    on(event: 'finish', listener: () => void): void;
}

/** Conta requisições por método, rota-template (baixa cardinalidade) e status. */
export function httpMetricsMiddleware(
    request: MinimalRequest,
    response: MinimalResponse,
    next: () => void,
): void {
    response.on('finish', () => {
        metrics.httpRequestsTotal.inc({
            method: request.method,
            route: request.route?.path ?? 'unmatched',
            status: String(response.statusCode),
        });
    });
    next();
}
