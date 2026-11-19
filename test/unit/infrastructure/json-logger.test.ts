import { describe, expect, it } from 'bun:test';
import { JsonLogger, redact } from '../../../src/infrastructure/observability/json-logger.js';
import {
    bindLogContext,
    correlationIdMiddleware,
    getLogContext,
    runWithLogContext,
} from '../../../src/infrastructure/observability/request-context.js';

function capture() {
    const lines: Array<Record<string, any>> = [];
    return { lines, logger: new JsonLogger((line) => lines.push(JSON.parse(line)), 'debug') };
}

describe('JsonLogger', () => {
    it('emits one JSON object per event with the correlation fields of the async context', () => {
        const { lines, logger } = capture();

        runWithLogContext({ correlationId: 'corr-1', walletId: 'w-1', providerId: 'p-1' }, () => {
            bindLogContext({ transactionId: 't-1', messageId: 'm-1' });
            logger.log(JSON.stringify({ event: 'wager_transaction_processed', status: 'PROCESSED' }), 'ProcessWager');
        });

        expect(lines[0]).toMatchObject({
            level: 'info',
            context: 'ProcessWager',
            msg: 'wager_transaction_processed',
            status: 'PROCESSED',
            correlationId: 'corr-1',
            walletId: 'w-1',
            providerId: 'p-1',
            transactionId: 't-1',
            messageId: 'm-1',
        });
        expect(typeof lines[0]!.ts).toBe('string');
    });

    it('keeps concurrent contexts isolated', async () => {
        const seen: string[] = [];
        await Promise.all(
            ['a', 'b', 'c'].map((id) =>
                runWithLogContext({ correlationId: id }, async () => {
                    await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
                    seen.push(`${id}:${getLogContext().correlationId}`);
                }),
            ),
        );
        expect(seen.sort()).toEqual(['a:a', 'b:b', 'c:c']);
    });

    it('never writes financial values or secrets', () => {
        const { lines, logger } = capture();

        logger.log({ event: 'x', money: { amount: '25.00' }, balance: '75.00', payload: { a: 1 }, authorization: 'Bearer abc', transactionId: 't' } as never);

        expect(lines[0]).toMatchObject({ money: '[REDACTED]', balance: '[REDACTED]', payload: '[REDACTED]', authorization: '[REDACTED]', transactionId: 't' });
        expect(JSON.stringify(lines[0])).not.toContain('25.00');
    });

    it('honours the minimum level', () => {
        const lines: string[] = [];
        const logger = new JsonLogger((line) => lines.push(line), 'warn');
        logger.log('info');
        logger.debug('debug');
        logger.warn('warn');
        logger.error('error');
        expect(lines).toHaveLength(2);
    });

    it('redact() leaves safe keys alone', () => {
        expect(redact({ walletId: 'w', errorCode: 'E' })).toEqual({ walletId: 'w', errorCode: 'E' });
    });
});

describe('correlationIdMiddleware', () => {
    it('propagates a valid incoming X-Correlation-Id and echoes it back', () => {
        const headers: Record<string, string> = {};
        let seen: string | undefined;

        correlationIdMiddleware({ headers: { 'x-correlation-id': 'abc-123' } }, { setHeader: (k, v) => (headers[k] = v) }, () => {
            seen = getLogContext().correlationId;
        });

        expect(seen).toBe('abc-123');
        expect(headers['X-Correlation-Id']).toBe('abc-123');
    });

    it('generates an id when missing and rejects unsafe values (log injection)', () => {
        for (const incoming of [undefined, 'bad value\nwith newline']) {
            let seen: string | undefined;
            correlationIdMiddleware({ headers: { 'x-correlation-id': incoming } }, { setHeader: () => undefined }, () => {
                seen = getLogContext().correlationId;
            });
            expect(seen).toMatch(/^[0-9a-f-]{36}$/);
        }
    });
});
