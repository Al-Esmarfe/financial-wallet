import { describe, expect, it } from 'bun:test';
import { computeRetryDelaySeconds, classifyConsumerError, errorCodeOf } from '../../../../src/application/messaging/error-classification.js';
import { validateMessagingConfig } from '../../../../src/application/messaging/messaging.config.js';
import { exponentialBackoffMs } from '../../../../src/application/messaging/backoff.js';
import { parseWagerTransactionRequested } from '../../../../src/application/messaging/wager-transaction-requested.message.js';
import {
    ApplicationValidationError,
    IdempotencyConflictError,
    MalformedMessageError,
    WalletNotFoundError,
} from '../../../../src/application/errors/application-errors.js';
import { CurrencyMismatchError, InvalidMoneyError, InvalidTransactionStateError } from '../../../../src/domain/errors/domain-errors.js';

const valid = (overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
    messageId: 'msg-123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        idempotencyKey: 'provider-a:transaction-123',
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        ...data,
    },
    ...overrides,
});

describe('WagerTransactionRequested envelope', () => {
    it('parses the exact message shape from the specification', () => {
        const parsed = parseWagerTransactionRequested(JSON.stringify(valid()));

        expect(parsed.messageId).toBe('msg-123');
        expect(parsed.occurredAt.toISOString()).toBe('2026-07-29T15:00:00.000Z');
        expect(parsed.input).toMatchObject({
            providerId: 'provider-a',
            idempotencyKey: 'provider-a:transaction-123',
            kind: 'BET',
            money: { amount: '25.00', currency: 'BRL' },
        });
    });

    it('produces the same payloadHash regardless of JSON key order', () => {
        const a = parseWagerTransactionRequested(JSON.stringify(valid()));
        const reordered = valid();
        const shuffled = { type: reordered.type, data: Object.fromEntries(Object.entries(reordered.data).reverse()), occurredAt: reordered.occurredAt, messageId: reordered.messageId };

        expect(parseWagerTransactionRequested(JSON.stringify(shuffled)).payloadHash).toBe(a.payloadHash);
    });

    it('changes the payloadHash when a business field changes, but not when only transport metadata changes', () => {
        const base = parseWagerTransactionRequested(JSON.stringify(valid())).payloadHash;

        expect(parseWagerTransactionRequested(JSON.stringify(valid({}, { money: { amount: '26.00', currency: 'BRL' } }))).payloadHash).not.toBe(base);
        expect(parseWagerTransactionRequested(JSON.stringify(valid({ occurredAt: '2030-01-01T00:00:00.000Z' }))).payloadHash).toBe(base);
    });

    it.each([
        ['not JSON', 'nope'],
        ['array', '[]'],
        ['missing messageId', JSON.stringify({ ...valid(), messageId: undefined })],
        ['wrong type', JSON.stringify(valid({ type: 'Other' }))],
        ['bad occurredAt', JSON.stringify(valid({ occurredAt: 'yesterday' }))],
        ['missing data', JSON.stringify({ ...valid(), data: undefined })],
        ['missing idempotencyKey', JSON.stringify(valid({}, { idempotencyKey: undefined }))],
        ['OPENING', JSON.stringify(valid({}, { kind: 'OPENING' }))],
        ['float amount', JSON.stringify(valid({}, { money: { amount: 25.5, currency: 'BRL' } }))],
        ['scientific notation', JSON.stringify(valid({}, { money: { amount: '1e3', currency: 'BRL' } }))],
        ['3 decimals', JSON.stringify(valid({}, { money: { amount: '1.234', currency: 'BRL' } }))],
        ['lowercase currency', JSON.stringify(valid({}, { money: { amount: '1.00', currency: 'brl' } }))],
        ['non-uuid wallet', JSON.stringify(valid({}, { walletId: 'wallet-1' }))],
        ['ROLLBACK without reference', JSON.stringify(valid({}, { kind: 'ROLLBACK' }))],
    ])('rejects %s as a malformed (permanent) message', (_label, body) => {
        expect(() => parseWagerTransactionRequested(body)).toThrow(MalformedMessageError);
    });
});

describe('consumer error classification', () => {
    it('validation / malformed / poison → PERMANENT (DLQ)', () => {
        expect(classifyConsumerError(new MalformedMessageError('x'))).toBe('PERMANENT');
        expect(classifyConsumerError(new ApplicationValidationError('x'))).toBe('PERMANENT');
        expect(classifyConsumerError(new InvalidMoneyError('x'))).toBe('PERMANENT');
        expect(classifyConsumerError(new CurrencyMismatchError('x'))).toBe('PERMANENT');
    });

    it('conflicts and not-found → BUSINESS_TERMINAL (ack)', () => {
        expect(classifyConsumerError(new IdempotencyConflictError())).toBe('BUSINESS_TERMINAL');
        expect(classifyConsumerError(new WalletNotFoundError('w'))).toBe('BUSINESS_TERMINAL');
    });

    it('infrastructure and unknown errors → TRANSIENT (retry)', () => {
        expect(classifyConsumerError(new Error('connection terminated'))).toBe('TRANSIENT');
        expect(classifyConsumerError('weird')).toBe('TRANSIENT');
        expect(classifyConsumerError(new InvalidTransactionStateError('bug'))).toBe('TRANSIENT');
    });

    it('exposes a stable machine-readable code', () => {
        expect(errorCodeOf(new WalletNotFoundError('w'))).toBe('WALLET_NOT_FOUND');
        expect(errorCodeOf(new InvalidMoneyError('x'))).toBe('INVALID_MONEY');
        expect(errorCodeOf(new TypeError('x'))).toBe('TypeError');
    });
});

describe('backoff', () => {
    it('grows exponentially up to the cap', () => {
        const noJitter = { jitterRatio: 0 };
        expect([1, 2, 3, 4].map((n) => exponentialBackoffMs(n, noJitter))).toEqual([1_000, 2_000, 4_000, 8_000]);
        expect(exponentialBackoffMs(30, { ...noJitter, capMs: 60_000 })).toBe(60_000);
        expect(exponentialBackoffMs(10_000, noJitter)).toBe(60_000); // sem overflow
    });

    it('adds bounded jitter', () => {
        expect(exponentialBackoffMs(1, { random: () => 0 })).toBe(1_000);
        expect(exponentialBackoffMs(1, { random: () => 1, jitterRatio: 0.25 })).toBe(1_250);
    });

    it('rejects attempts below 1', () => {
        expect(() => exponentialBackoffMs(0)).toThrow();
    });

    it('SQS visibility delay: 2s, 4s, 8s ... capped at 5 minutes', () => {
        expect([1, 2, 3, 4, 5].map((n) => computeRetryDelaySeconds(n))).toEqual([2, 4, 8, 16, 32]);
        expect(computeRetryDelaySeconds(20)).toBe(300);
    });
});

describe('validateMessagingConfig', () => {
    const base = {
        SQS_WAGER_TRANSACTIONS_QUEUE_URL: 'http://localhost:4566/000000000000/wager-transactions.fifo',
        SQS_WAGER_EVENTS_QUEUE_URL: 'http://localhost:4566/000000000000/wager-events.fifo',
    };

    it('aceita filas de entrada e de eventos distintas', () => {
        expect(() => validateMessagingConfig({ ...base })).not.toThrow();
    });

    it('recusa publicar eventos na própria fila de comandos', () => {
        expect(() =>
            validateMessagingConfig({ ...base, SQS_WAGER_EVENTS_QUEUE_URL: base.SQS_WAGER_TRANSACTIONS_QUEUE_URL }),
        ).toThrow('must differ');
    });

    it('recusa as variáveis antigas e ambíguas', () => {
        expect(() => validateMessagingConfig({ ...base, SQS_WAGER_QUEUE_URL: 'x' })).toThrow('no longer supported');
        expect(() => validateMessagingConfig({ ...base, SQS_WAGER_DLQ_URL: 'x' })).toThrow('no longer supported');
    });
});
