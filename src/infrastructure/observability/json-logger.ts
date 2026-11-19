import type { LoggerService } from '@nestjs/common';
import { getLogContext } from './request-context.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const SENSITIVE_KEYS = new Set([
    'payload',
    'body',
    'money',
    'amount',
    'balance',
    'authorization',
    'password',
    'secret',
    'token',
]);

/** Remove campos financeiros/sensíveis: logs carregam IDs e códigos, nunca valores. */
export function redact(fields: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
        out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : value;
    }
    return out;
}

/**
 * Logger NestJS que emite uma linha JSON por evento, com os campos de
 * correlação do contexto assíncrono corrente (correlationId, messageId,
 * transactionId, walletId, providerId).
 *
 * Aceita tanto `logger.log('texto')` quanto `logger.log(JSON.stringify({...}))`
 * (padrão já usado no código): neste caso o objeto é mesclado ao registro.
 */
export class JsonLogger implements LoggerService {
    constructor(
        private readonly write: (line: string) => void = (line) =>
            process.stdout.write(`${line}\n`),
        private readonly minLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info',
    ) {}

    log(message: unknown, ...optional: unknown[]): void {
        this.emit('info', message, optional);
    }

    error(message: unknown, ...optional: unknown[]): void {
        this.emit('error', message, optional);
    }

    warn(message: unknown, ...optional: unknown[]): void {
        this.emit('warn', message, optional);
    }

    debug(message: unknown, ...optional: unknown[]): void {
        this.emit('debug', message, optional);
    }

    verbose(message: unknown, ...optional: unknown[]): void {
        this.emit('debug', message, optional);
    }

    private emit(level: Level, message: unknown, optional: unknown[]): void {
        const order: Level[] = ['debug', 'info', 'warn', 'error'];
        if (order.indexOf(level) < order.indexOf(this.minLevel)) return;

        // Nest passa o contexto (nome da classe) como último argumento string.
        const last = optional[optional.length - 1];
        const context = typeof last === 'string' ? last : undefined;
        const stack =
            level === 'error' && typeof optional[0] === 'string' && optional.length > 1
                ? (optional[0] as string)
                : undefined;

        let fields: Record<string, unknown> = {};
        let text: string;
        if (typeof message === 'string') {
            const parsed = this.tryParseObject(message);
            if (parsed) {
                fields = parsed;
                text = typeof parsed.event === 'string' ? parsed.event : 'log';
            } else {
                text = message;
            }
        } else if (message instanceof Error) {
            text = message.message;
            fields = { errorName: message.name };
        } else if (typeof message === 'object' && message !== null) {
            fields = message as Record<string, unknown>;
            text = typeof fields.event === 'string' ? fields.event : 'log';
        } else {
            text = String(message);
        }

        const record = {
            ts: new Date().toISOString(),
            level,
            ...(context ? { context } : {}),
            msg: text,
            ...redact(fields),
            ...getLogContext(),
            ...(stack ? { stack } : {}),
        };
        this.write(JSON.stringify(record));
    }

    private tryParseObject(text: string): Record<string, unknown> | undefined {
        if (!text.startsWith('{')) return undefined;
        try {
            const value: unknown = JSON.parse(text);
            return typeof value === 'object' && value !== null && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : undefined;
        } catch {
            return undefined;
        }
    }
}
