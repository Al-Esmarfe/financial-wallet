import { describe, expect, it } from 'bun:test';

import { InboxMessage } from '../../../../src/domain/messaging/inbox-message.js';
import { OutboxMessage } from '../../../../src/domain/messaging/outbox-message.js';
import { InvariantViolationError } from '../../../../src/domain/errors/domain-errors.js';

const receive = (payloadHash = 'hash-a') =>
    InboxMessage.receive({
        id: 'inbox-1',
        consumerName: 'wager-transactions-consumer',
        messageId: 'msg-1',
        payloadHash,
        payload: { messageId: 'msg-1' },
        receivedAt: new Date('2026-01-01T00:00:00Z'),
    });

describe('InboxMessage', () => {
    it('nasce RECEIVED e não processada', () => {
        const message = receive();
        expect(message.status).toBe('RECEIVED');
        expect(message.isProcessed()).toBe(false);
        expect(message.processedAt).toBeUndefined();
    });

    it('detecta payload divergente para o mesmo messageId', () => {
        const message = receive('hash-a');
        expect(message.matchesPayload('hash-a')).toBe(true);
        expect(message.matchesPayload('hash-b')).toBe(false);
    });

    it('markProcessed é terminal: processar de novo é erro de programação', () => {
        const message = receive();
        const at = new Date('2026-01-01T00:00:05Z');
        message.markProcessed(at);
        expect(message.isProcessed()).toBe(true);
        expect(message.processedAt).toEqual(at);
        expect(() => message.markProcessed(at)).toThrow(InvariantViolationError);
    });

    it('rehydrate reconstrói o estado persistido sem revalidar transições', () => {
        const message = InboxMessage.rehydrate({
            id: 'inbox-1',
            consumerName: 'c',
            messageId: 'm',
            payloadHash: 'h',
            payload: {},
            receivedAt: new Date(),
            status: 'DEAD_LETTERED',
        });
        expect(message.isTerminal()).toBe(true);
        expect(message.isProcessed()).toBe(false);
    });

    it('exige identificadores e hash', () => {
        expect(() =>
            InboxMessage.receive({
                id: 'x',
                consumerName: 'c',
                messageId: ' ',
                payloadHash: 'h',
                payload: {},
                receivedAt: new Date(),
            }),
        ).toThrow(InvariantViolationError);
    });
});

const event = {
    eventId: 'event-1',
    eventType: 'WagerTransactionProcessed',
    aggregateId: 'tx-1',
    occurredAt: new Date('2026-01-01T00:00:00Z'),
    toJSON: () => ({ eventId: 'event-1', data: { amount: { amount: '25.00', currency: 'BRL' } } }),
};
const policy = { maxAttempts: 3, baseMs: 1_000, capMs: 60_000, random: () => 0 };

describe('OutboxMessage', () => {
    it('enqueue congela o envelope JSON e nasce PENDING com 0 tentativas', () => {
        const message = OutboxMessage.enqueue(event, 'WagerTransaction');
        expect(message.status).toBe('PENDING');
        expect(message.attempts).toBe(0);
        expect(message.isPending()).toBe(true);
        expect(message.payload).toEqual({ eventId: 'event-1', data: { amount: { amount: '25.00', currency: 'BRL' } } });
        expect(Object.isFrozen(message.payload)).toBe(true);
        expect(message.isDue(new Date())).toBe(true);
    });

    it('scheduleRetry incrementa attempts e aplica backoff exponencial', () => {
        const message = OutboxMessage.enqueue(event, 'WagerTransaction');
        const now = new Date('2026-01-01T00:00:00Z');

        message.scheduleRetry(now, policy, 'SQS down');
        expect(message.attempts).toBe(1);
        expect(message.status).toBe('PENDING');
        expect(message.nextAttemptAt!.getTime() - now.getTime()).toBe(1_000);
        expect(message.isDue(now)).toBe(false);
        expect(message.isDue(new Date(now.getTime() + 1_000))).toBe(true);

        message.scheduleRetry(now, policy);
        expect(message.nextAttemptAt!.getTime() - now.getTime()).toBe(2_000);
    });

    it('ao esgotar as tentativas fica FAILED estacionado, mas continua elegível no teto (nunca perdido)', () => {
        const message = OutboxMessage.enqueue(event, 'WagerTransaction');
        const now = new Date('2026-01-01T00:00:00Z');
        for (let i = 0; i < 3; i++) message.scheduleRetry(now, policy, 'down');

        expect(message.status).toBe('FAILED');
        expect(message.isParked()).toBe(true);
        expect(message.isPending()).toBe(true);
        expect(message.nextAttemptAt!.getTime() - now.getTime()).toBe(60_000);
        expect(message.isDue(new Date(now.getTime() + 60_000))).toBe(true);
    });

    it('markPublished é terminal', () => {
        const message = OutboxMessage.enqueue(event, 'WagerTransaction');
        message.markPublished(new Date());
        expect(message.isPending()).toBe(false);
        expect(message.isDue(new Date())).toBe(false);
        expect(() => message.markPublished(new Date())).toThrow(InvariantViolationError);
        expect(() => message.scheduleRetry(new Date(), policy)).toThrow(InvariantViolationError);
    });
});
