import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
    INBOX_CONSUMER_NAME,
    InboxConsumerWorker,
} from '../../../../src/application/workers/inbox-consumer.worker.js';
import { ProcessWagerTransactionUseCase } from '../../../../src/application/use-cases/wagering/process-wager-transaction.use-case.js';
import { ReferenceRetryPolicy } from '../../../../src/domain/transactions/reference-retry-policy.js';
import { metrics } from '../../../../src/infrastructure/observability/metrics.js';
import { InMemoryDatabase } from '../../../support/in-memory-unit-of-work.js';

const INBOUND = 'http://localhost/wager-transactions.fifo';
const DLQ = 'http://localhost/wager-transactions-dlq.fifo';

const savedEnv = {
    inbound: process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL,
    dlq: process.env.SQS_WAGER_TRANSACTIONS_DLQ_URL,
    legacyInbound: process.env.SQS_WAGER_COMMAND_QUEUE_URL,
    legacyDlq: process.env.SQS_WAGER_COMMAND_DLQ_URL,
};

function restore(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

beforeEach(() => {
    process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL = INBOUND;
    process.env.SQS_WAGER_TRANSACTIONS_DLQ_URL = DLQ;
    delete process.env.SQS_WAGER_COMMAND_QUEUE_URL;
    delete process.env.SQS_WAGER_COMMAND_DLQ_URL;
    process.env.INBOX_WAIT_TIME_SECONDS = '0';
    metrics.inboxMessagesTotal.reset();
    metrics.dlqMessagesTotal.reset();
    metrics.retriesTotal.reset();
});

afterEach(() => {
    restore('SQS_WAGER_TRANSACTIONS_QUEUE_URL', savedEnv.inbound);
    restore('SQS_WAGER_TRANSACTIONS_DLQ_URL', savedEnv.dlq);
    restore('SQS_WAGER_COMMAND_QUEUE_URL', savedEnv.legacyInbound);
    restore('SQS_WAGER_COMMAND_DLQ_URL', savedEnv.legacyDlq);
    delete process.env.INBOX_WAIT_TIME_SECONDS;
});

/** Mensagem no formato exato do enunciado (envelope + data). */
function envelope(walletId: string, playerId: string, overrides: Record<string, unknown> = {}, messageId = 'msg-123') {
    return {
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: '2026-07-29T15:00:00.000Z',
        data: {
            providerId: 'provider-a',
            externalTransactionId: 'transaction-123',
            idempotencyKey: 'provider-a:transaction-123',
            playerId,
            walletId,
            roundId: 'round-987',
            gameId: 'fortune-chimp',
            kind: 'BET',
            money: { amount: '25.00', currency: 'BRL' },
            ...overrides,
        },
    };
}

interface FakeSqsOptions {
    receiveCount?: number;
    dlqFails?: boolean;
    /** Substitui o caso de uso (para simular falhas de infraestrutura no commit financeiro). */
    useCase?: { execute: (...args: any[]) => Promise<any> };
}

function createHarness(db: InMemoryDatabase, bodies: string[], options: FakeSqsOptions = {}) {
    const sent: Array<{ name: string; input: any }> = [];
    const sqs = {
        send: async (command: { constructor: { name: string }; input: any }) => {
            const name = command.constructor.name;
            sent.push({ name, input: command.input });
            if (name === 'ReceiveMessageCommand') {
                return {
                    Messages: bodies.map((body, index) => ({
                        MessageId: `sqs-${index + 1}`,
                        ReceiptHandle: `receipt-${index + 1}`,
                        Body: body,
                        Attributes: {
                            MessageGroupId: 'group-1',
                            ApproximateReceiveCount: String(options.receiveCount ?? 1),
                        },
                    })),
                };
            }
            if (name === 'SendMessageCommand' && options.dlqFails) throw new Error('DLQ unavailable');
            return {};
        },
    };
    const useCase = options.useCase ?? new ProcessWagerTransactionUseCase(db, new ReferenceRetryPolicy());
    const worker = new InboxConsumerWorker(db as never, useCase as never, sqs as never);
    const names = () => sent.map((item) => item.name);
    return { worker, sent, names };
}

describe('InboxConsumerWorker', () => {
    it('parses the spec envelope, runs the SAME use case, commits, and only then acks', async () => {
        const db = new InMemoryDatabase();
        const wallet = db.seedWallet({ balance: '100.00' });
        const { worker, names } = createHarness(db, [JSON.stringify(envelope(wallet.walletId, wallet.playerId))]);

        const result = await worker.consumeBatch();

        expect(result).toEqual({ received: 1, processed: 1, duplicates: 0, rejected: 0, deadLettered: 0, failed: 0 });
        expect(db.wallet(wallet.walletId).balance).toBe('75.00');
        expect(db.inboxStatus(INBOX_CONSUMER_NAME, 'msg-123')).toBe('PROCESSED'); // chave = messageId do envelope
        expect(names()).toEqual(['ReceiveMessageCommand', 'DeleteMessageCommand']);
        expect(metrics.inboxMessagesTotal.get({ result: 'processed' })).toBe(1);
    });

    it('acks a redelivered, already-processed message without a second debit (crash between commit and ack)', async () => {
        const db = new InMemoryDatabase();
        const wallet = db.seedWallet({ balance: '100.00' });
        const body = JSON.stringify(envelope(wallet.walletId, wallet.playerId));

        await createHarness(db, [body]).worker.consumeBatch(); // 1ª entrega: commit OK (ack "perdido")
        const second = createHarness(db, [body], { receiveCount: 2 });
        const result = await second.worker.consumeBatch();

        expect(result.duplicates).toBe(1);
        expect(result.processed).toBe(0);
        expect(db.wallet(wallet.walletId).balance).toBe('75.00');
        expect(second.names()).toEqual(['ReceiveMessageCommand', 'DeleteMessageCommand']);
    });

    it('treats the same request re-published under a NEW messageId as an idempotent replay', async () => {
        const db = new InMemoryDatabase();
        const wallet = db.seedWallet({ balance: '100.00' });
        await createHarness(db, [JSON.stringify(envelope(wallet.walletId, wallet.playerId, {}, 'msg-A'))]).worker.consumeBatch();

        const result = await createHarness(db, [
            JSON.stringify(envelope(wallet.walletId, wallet.playerId, {}, 'msg-B')),
        ]).worker.consumeBatch();

        expect(result.duplicates).toBe(1);
        expect(db.wallet(wallet.walletId).balance).toBe('75.00');
    });

    it('acks a business REJECTION (insufficient funds) as a normal, terminal outcome', async () => {
        const db = new InMemoryDatabase();
        const wallet = db.seedWallet({ balance: '10.00' });
        const { worker, names } = createHarness(db, [JSON.stringify(envelope(wallet.walletId, wallet.playerId))]);

        const result = await worker.consumeBatch();

        expect(result.processed).toBe(1); // a transação foi processada: REJECTED persistida
        expect(db.wallet(wallet.walletId).balance).toBe('10.00');
        expect(names()).toContain('DeleteMessageCommand');
        expect(names()).not.toContain('SendMessageCommand');
    });

    it('acks (does not retry, does not DLQ) a business error raised as exception: unknown wallet', async () => {
        const db = new InMemoryDatabase();
        const { worker, names } = createHarness(db, [
            JSON.stringify(envelope(crypto.randomUUID(), 'player-x')),
        ]);

        const result = await worker.consumeBatch();

        expect(result.rejected).toBe(1);
        expect(db.inboxStatus(INBOX_CONSUMER_NAME, 'msg-123')).toBe('REJECTED');
        expect(names()).toEqual(['ReceiveMessageCommand', 'DeleteMessageCommand']);
        expect(metrics.inboxMessagesTotal.get({ result: 'business_rejected' })).toBe(1);
    });

    describe('permanent errors → DLQ', () => {
        const cases: Array<[string, string]> = [
            ['invalid JSON', '{not json'],
            ['wrong type', JSON.stringify({ ...envelope(crypto.randomUUID(), 'p'), type: 'SomethingElse' })],
            ['flat legacy payload without envelope', JSON.stringify(envelope(crypto.randomUUID(), 'p').data)],
            ['OPENING kind (internal only)', JSON.stringify(envelope(crypto.randomUUID(), 'p', { kind: 'OPENING' }))],
            ['negative amount', JSON.stringify(envelope(crypto.randomUUID(), 'p', { money: { amount: '-5.00', currency: 'BRL' } }))],
            ['numeric (non-string) amount', JSON.stringify(envelope(crypto.randomUUID(), 'p', { money: { amount: 25, currency: 'BRL' } }))],
            ['REFUND without reference', JSON.stringify(envelope(crypto.randomUUID(), 'p', { kind: 'REFUND' }))],
        ];

        for (const [label, body] of cases) {
            it(`sends "${label}" to the DLQ, records DEAD_LETTERED and removes the original`, async () => {
                const db = new InMemoryDatabase();
                const { worker, names, sent } = createHarness(db, [body]);

                const result = await worker.consumeBatch();

                expect(result.deadLettered).toBe(1);
                expect(names()).toEqual(['ReceiveMessageCommand', 'SendMessageCommand', 'DeleteMessageCommand']);
                const dlqSend = sent.find((s) => s.name === 'SendMessageCommand')!;
                expect(dlqSend.input.QueueUrl).toBe(DLQ);
                expect(dlqSend.input.MessageBody).toBe(body); // corpo original preservado
                expect(dlqSend.input.MessageGroupId).toBe('group-1');
                expect(dlqSend.input.MessageAttributes.DeadLetterReason.StringValue).toStartWith('PERMANENT:');
                expect([...db.state.inbox.values()].map((row) => row.status)).toEqual(['DEAD_LETTERED']);
                expect(metrics.dlqMessagesTotal.total()).toBe(1);
            });
        }

        it('flags a reused messageId with a different payload as poison → DLQ', async () => {
            const db = new InMemoryDatabase();
            const wallet = db.seedWallet({ balance: '100.00' });
            await createHarness(db, [JSON.stringify(envelope(wallet.walletId, wallet.playerId))]).worker.consumeBatch();

            const tampered = JSON.stringify(
                envelope(wallet.walletId, wallet.playerId, { money: { amount: '99.00', currency: 'BRL' } }, 'msg-123'),
            );
            const result = await createHarness(db, [tampered]).worker.consumeBatch();

            expect(result.deadLettered).toBe(1);
            expect(db.wallet(wallet.walletId).balance).toBe('75.00');
        });

        it('does NOT delete the original when the DLQ send fails (message is never lost)', async () => {
            const db = new InMemoryDatabase();
            const { worker, names } = createHarness(db, ['{not json'], { dlqFails: true });

            const result = await worker.consumeBatch();

            expect(result.failed).toBe(1);
            expect(names()).not.toContain('DeleteMessageCommand');
        });
    });

    describe('transient errors → retry with backoff, then DLQ', () => {
        const connectionLost = {
            execute: async () => {
                throw Object.assign(new Error('connection terminated unexpectedly'), { code: 'ECONNRESET' });
            },
        };

        it('does not ack; records FAILED; hides the message with exponential backoff', async () => {
            const db = new InMemoryDatabase();
            const wallet = db.seedWallet({ balance: '100.00' });
            const { worker, sent, names } = createHarness(
                db,
                [JSON.stringify(envelope(wallet.walletId, wallet.playerId))],
                { receiveCount: 3, useCase: connectionLost },
            );

            const result = await worker.consumeBatch();

            expect(result.failed).toBe(1);
            expect(names()).not.toContain('DeleteMessageCommand');
            expect(names()).not.toContain('SendMessageCommand');
            const visibility = sent.find((s) => s.name === 'ChangeMessageVisibilityCommand')!;
            expect(visibility.input.VisibilityTimeout).toBe(8); // 2s * 2^(3-1)
            expect(db.inboxStatus(INBOX_CONSUMER_NAME, 'msg-123')).toBe('FAILED');
            expect(metrics.retriesTotal.get({ source: 'sqs_inbound' })).toBe(1);
            expect(db.wallet(wallet.walletId).balance).toBe('100.00');
        });

        it('backs off further on every redelivery (2s, 4s, 8s, 16s)', async () => {
            const delays: number[] = [];
            for (const receiveCount of [1, 2, 3, 4]) {
                const db = new InMemoryDatabase();
                const wallet = db.seedWallet();
                const { worker, sent } = createHarness(
                    db,
                    [JSON.stringify(envelope(wallet.walletId, wallet.playerId))],
                    { receiveCount, useCase: connectionLost },
                );
                await worker.consumeBatch();
                delays.push(sent.find((s) => s.name === 'ChangeMessageVisibilityCommand')!.input.VisibilityTimeout);
            }
            expect(delays).toEqual([2, 4, 8, 16]);
        });

        it('dead-letters once the receive limit is reached, with a distinct reason', async () => {
            const db = new InMemoryDatabase();
            const wallet = db.seedWallet({ balance: '100.00' });
            const { worker, sent } = createHarness(
                db,
                [JSON.stringify(envelope(wallet.walletId, wallet.playerId))],
                { receiveCount: 5, useCase: connectionLost },
            );

            const result = await worker.consumeBatch();

            expect(result.deadLettered).toBe(1);
            const dlqSend = sent.find((s) => s.name === 'SendMessageCommand')!;
            expect(dlqSend.input.MessageAttributes.DeadLetterReason.StringValue).toBe('MAX_RECEIVE_COUNT_EXCEEDED');
            expect(db.inboxStatus(INBOX_CONSUMER_NAME, 'msg-123')).toBe('DEAD_LETTERED');
        });

        it('keeps the message untouched when even recording the failure is impossible (PostgreSQL down)', async () => {
            const db = new InMemoryDatabase();
            const wallet = db.seedWallet();
            db.execute = (async () => {
                throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
            }) as never;
            const { worker, names } = createHarness(db, [JSON.stringify(envelope(wallet.walletId, wallet.playerId))]);

            const result = await worker.consumeBatch();

            expect(result.failed).toBe(1);
            expect(names()).toEqual(['ReceiveMessageCommand']); // sem ack: reaparece após o visibility timeout
        });
    });

    describe('cooperative shutdown (SIGTERM)', () => {
        function gatedUseCase() {
            let release!: () => void;
            let entered!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            const started = new Promise<void>((resolve) => (entered = resolve));
            return {
                release,
                started,
                useCase: {
                    execute: async () => {
                        entered();
                        await gate;
                        return { status: 'PROCESSED', idempotentReplay: false, transactionId: 't', balance: null };
                    },
                },
            };
        }

        it('finishes the message in flight, then RETURNS the unstarted ones (visibility 0)', async () => {
            const db = new InMemoryDatabase();
            const wallet = db.seedWallet({ balance: '1000.00' });
            const bodies = [1, 2, 3].map((n) =>
                JSON.stringify(envelope(wallet.walletId, wallet.playerId, { externalTransactionId: `t-${n}`, idempotencyKey: `k-${n}` }, `msg-${n}`)),
            );
            const gated = gatedUseCase();
            const { worker, sent, names } = createHarness(db, bodies, { useCase: gated.useCase });

            const batch = worker.consumeBatch();
            await gated.started; // 1ª mensagem está em processamento
            let destroyed = false;
            const destroying = worker.onModuleDestroy().then(() => (destroyed = true));
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(destroyed).toBe(false); // SIGTERM espera a mensagem em andamento

            gated.release();
            await Promise.all([batch, destroying]);

            expect(destroyed).toBe(true);
            const deleted = sent.filter((s) => s.name === 'DeleteMessageCommand').map((s) => s.input.ReceiptHandle);
            expect(deleted).toEqual(['receipt-1']); // concluída e confirmada
            const released = sent.filter((s) => s.name === 'ChangeMessageVisibilityCommand');
            expect(released.map((s) => s.input.ReceiptHandle)).toEqual(['receipt-2', 'receipt-3']);
            expect(released.every((s) => s.input.VisibilityTimeout === 0)).toBe(true);
            expect(names().filter((n) => n === 'SendMessageCommand')).toHaveLength(0);
        });

        it('does not start a new batch after shutdown began', async () => {
            const db = new InMemoryDatabase();
            const { worker, sent } = createHarness(db, ['{}']);

            await worker.onModuleDestroy();
            const result = await worker.consumeBatch();

            expect(result.received).toBe(0);
            expect(sent).toHaveLength(0);
        });
    });

    it('does nothing when the inbound queue is not configured', async () => {
        delete process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL;
        const db = new InMemoryDatabase();
        const { worker, sent } = createHarness(db, ['{}']);

        expect(await worker.consumeBatch()).toEqual({ received: 0, processed: 0, duplicates: 0, rejected: 0, deadLettered: 0, failed: 0 });
        expect(sent).toHaveLength(0);
    });

    it('still honours the legacy SQS_WAGER_COMMAND_QUEUE_URL variable', async () => {
        delete process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL;
        process.env.SQS_WAGER_COMMAND_QUEUE_URL = 'http://localhost/legacy.fifo';
        const db = new InMemoryDatabase();
        const wallet = db.seedWallet();
        const { worker, sent } = createHarness(db, [JSON.stringify(envelope(wallet.walletId, wallet.playerId))]);

        await worker.consumeBatch();

        expect(sent[0]!.input.QueueUrl).toBe('http://localhost/legacy.fifo');
    });
});
