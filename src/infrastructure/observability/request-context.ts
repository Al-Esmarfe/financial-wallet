import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface LogContext {
    correlationId?: string;
    messageId?: string;
    transactionId?: string;
    walletId?: string;
    providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Executa `fn` com um contexto de log; qualquer log dentro dele herda os campos. */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
    return storage.run({ ...context }, fn);
}

export function getLogContext(): LogContext {
    return storage.getStore() ?? {};
}

/** Acrescenta campos ao contexto corrente (ex.: walletId depois de resolvido). */
export function bindLogContext(fields: LogContext): void {
    const store = storage.getStore();
    if (store) Object.assign(store, fields);
}

export function newCorrelationId(): string {
    return randomUUID();
}

interface MinimalRequest {
    headers: Record<string, string | string[] | undefined>;
}
interface MinimalResponse {
    setHeader(name: string, value: string): void;
}

const CORRELATION_HEADER = 'x-correlation-id';

/** Middleware Express: propaga/gera o correlationId e o devolve no header de resposta. */
export function correlationIdMiddleware(
    request: MinimalRequest,
    response: MinimalResponse,
    next: () => void,
): void {
    const incoming = request.headers[CORRELATION_HEADER];
    const raw = Array.isArray(incoming) ? incoming[0] : incoming;
    const correlationId =
        raw && /^[\w.:-]{1,100}$/.test(raw) ? raw : newCorrelationId();
    response.setHeader('X-Correlation-Id', correlationId);
    runWithLogContext({ correlationId }, next);
}
