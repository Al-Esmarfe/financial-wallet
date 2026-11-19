import { WagerTransactionFailureCode } from '../../../../src/domain/transactions/wager-transaction-failure-code.js';
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../../src/domain/money/money.js';
import { WagerTransaction } from '../../../../src/domain/transactions/wager-transaction.js';
import { WagerTransactionStatus } from '../../../../src/domain/transactions/wager-transaction-status.js';
import { WagerTransactionType } from '../../../../src/domain/transactions/wager-transaction-type.js';
import { LedgerEntryDirection } from '../../../../src/domain/ledger/ledger-entry-direction.js';

const validProps = () => ({
    id: 'tx-1',
    providerId: 'provider-1',
    providerTransactionId: 'external-1',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    type: WagerTransactionType.BET,
    amount: Money.create('10.00', 'BRL'),
    idempotencyKey: 'idem-1',
    requestHash: 'hash-1',
    gameId: 'game-123',
});

describe('WagerTransaction', () => {
    describe('create', () => {
        it('creates a transaction in PENDING status', () => {
            const transaction = WagerTransaction.create(validProps());

            expect(transaction.status).toBe(WagerTransactionStatus.PENDING);
            expect(transaction.amount.toString()).toBe('10.00');
        });

        it.each([
            'id',
            'providerId',
            'providerTransactionId',
            'playerId',
            'walletId',
            'roundId',
            'idempotencyKey',
            'requestHash',
        ] as const)('rejects an empty %s', (field) => {
            const props = validProps();
            (props as Record<string, unknown>)[field] = ' ';

            expect(() => WagerTransaction.create(props)).toThrow();
        });

        it('rejects zero or negative amount', () => {
            expect(() =>
                WagerTransaction.create({
                    ...validProps(),
                    amount: Money.zero('BRL'),
                }),
            ).toThrow();

            expect(() =>
                WagerTransaction.create({
                    ...validProps(),
                    amount: Money.create('-1.00', 'BRL'),
                }),
            ).toThrow();
        });

        it('requires a reference for REFUND', () => {
            expect(() =>
                WagerTransaction.create({
                    ...validProps(),
                    type: WagerTransactionType.REFUND,
                }),
            ).toThrow();
        });

        it('requires a reference for ROLLBACK', () => {
            expect(() =>
                WagerTransaction.create({
                    ...validProps(),
                    type: WagerTransactionType.ROLLBACK,
                }),
            ).toThrow();
        });

        it('accepts a reference for REFUND and ROLLBACK', () => {
            for (const type of [
                WagerTransactionType.REFUND,
                WagerTransactionType.ROLLBACK,
            ]) {
                const transaction = WagerTransaction.create({
                    ...validProps(),
                    type,
                    referenceTransactionId: 'original-tx',
                });

                expect(transaction.referenceTransactionId).toBe('original-tx');
            }
        });
    });

    describe('state transitions', () => {
        it('moves from PENDING to PENDING_REFERENCE', () => {
            const transaction = WagerTransaction.create(validProps());

            transaction.markPendingReference();

            expect(transaction.status).toBe(
                WagerTransactionStatus.PENDING_REFERENCE,
            );
        });

        it('moves from PENDING to PROCESSED', () => {
            const transaction = WagerTransaction.create(validProps());

            transaction.markProcessed();

            expect(transaction.status).toBe(WagerTransactionStatus.PROCESSED);
        });

        it('moves from PENDING_REFERENCE to PROCESSED', () => {
            const transaction = WagerTransaction.create(validProps());

            transaction.markPendingReference();
            transaction.markProcessed();

            expect(transaction.status).toBe(WagerTransactionStatus.PROCESSED);
        });

        it('rejects a transaction with a reason', () => {
            const transaction = WagerTransaction.create(validProps());

            transaction.reject('Insufficient funds', WagerTransactionFailureCode.INVALID_TRANSACTION);

            expect(transaction.status).toBe(WagerTransactionStatus.REJECTED);
            expect(transaction.rejectionReason).toBe('Insufficient funds');
        });

        it('fails a transaction with a reason', () => {
            const transaction = WagerTransaction.create(validProps());

            transaction.fail('Unexpected processing error');

            expect(transaction.status).toBe(WagerTransactionStatus.FAILED);
            expect(transaction.failureReason).toBe(
                'Unexpected processing error',
            );
        });

        it('rejects empty rejection and failure reasons', () => {
            const rejection = WagerTransaction.create(validProps());
            const failure = WagerTransaction.create(validProps());

            expect(() => rejection.reject(' ', WagerTransactionFailureCode.INVALID_TRANSACTION)).toThrow();
            expect(() => failure.fail(' ')).toThrow();
        });

        it('does not allow changes after PROCESSED', () => {
            const transaction = WagerTransaction.create(validProps());
            transaction.markProcessed();

            expect(() => transaction.markPendingReference()).toThrow();
            expect(() => transaction.reject('reason', WagerTransactionFailureCode.INVALID_TRANSACTION)).toThrow();
            expect(() => transaction.fail('reason')).toThrow();
        });

        it('does not allow changes after REJECTED', () => {
            const transaction = WagerTransaction.create(validProps());
            transaction.reject('reason', WagerTransactionFailureCode.INVALID_TRANSACTION);

            expect(() => transaction.markProcessed()).toThrow();
            expect(() => transaction.fail('reason')).toThrow();
        });

        it('does not allow changes after FAILED', () => {
            const transaction = WagerTransaction.create(validProps());
            transaction.fail('reason');

            expect(() => transaction.markProcessed()).toThrow();
            expect(() => transaction.reject('reason', WagerTransactionFailureCode.INVALID_TRANSACTION)).toThrow();
        });
    });

    describe('rehydrate', () => {
        it('restores status and audit reasons', () => {
            const transaction = WagerTransaction.rehydrate({
                ...validProps(),
                status: WagerTransactionStatus.REJECTED,
                rejectionReason: 'Insufficient funds',
            });

            expect(transaction.status).toBe(WagerTransactionStatus.REJECTED);
            expect(transaction.rejectionReason).toBe('Insufficient funds');
        });
    });

    describe('business rules', () => {
        it('identifies transactions that affect the balance', () => {
            const types = [
                WagerTransactionType.OPENING,
                WagerTransactionType.BET,
                WagerTransactionType.WIN,
                WagerTransactionType.REFUND,
                WagerTransactionType.ROLLBACK,
            ];

            for (const type of types) {
                const transaction = WagerTransaction.create({
                    ...validProps(),
                    type,
                    referenceTransactionId:
                        type === WagerTransactionType.REFUND ||
                        type === WagerTransactionType.ROLLBACK
                            ? 'reference-1'
                            : undefined,
                });

                expect(transaction.affectsBalance()).toBe(true);
            }

            const loss = WagerTransaction.create({
                ...validProps(),
                type: WagerTransactionType.LOSS,
            });

            expect(loss.affectsBalance()).toBe(false);
        });

        it('identifies transactions that require a reference', () => {
            for (const type of [
                WagerTransactionType.REFUND,
                WagerTransactionType.ROLLBACK,
            ]) {
                const transaction = WagerTransaction.create({
                    ...validProps(),
                    type,
                    referenceTransactionId: 'reference-1',
                });

                expect(transaction.requiresReference()).toBe(true);
            }

            const bet = WagerTransaction.create(validProps());

            expect(bet.requiresReference()).toBe(false);
        });

        it('matches the original payload hash', () => {
            const transaction = WagerTransaction.create(validProps());

            expect(transaction.matchesPayload('hash-1')).toBe(true);
            expect(transaction.matchesPayload('different-hash')).toBe(false);
        });

        it('returns the correct ledger direction', () => {
            const cases = [
                [WagerTransactionType.OPENING, LedgerEntryDirection.CREDIT],
                [WagerTransactionType.BET, LedgerEntryDirection.DEBIT],
                [WagerTransactionType.WIN, LedgerEntryDirection.CREDIT],
                [WagerTransactionType.REFUND, LedgerEntryDirection.CREDIT],
            ] as const;

            for (const [type, direction] of cases) {
                const transaction = WagerTransaction.create({
                    ...validProps(),
                    type,
                    referenceTransactionId:
                        type === WagerTransactionType.REFUND
                            ? 'reference-1'
                            : undefined,
                });

                expect(transaction.ledgerDirectionFor()).toBe(direction);
            }
        });

        it('returns no ledger direction for LOSS', () => {
            const transaction = WagerTransaction.create({
                ...validProps(),
                type: WagerTransactionType.LOSS,
            });

            expect(transaction.ledgerDirectionFor()).toBeUndefined();
        });

        it('reverses the financial direction for ROLLBACK', () => {
            const bet = WagerTransaction.create({
                ...validProps(),
                type: WagerTransactionType.BET,
            });

            const win = WagerTransaction.create({
                ...validProps(),
                id: 'tx-2',
                type: WagerTransactionType.WIN,
            });

            const rollback = WagerTransaction.create({
                ...validProps(),
                type: WagerTransactionType.ROLLBACK,
                referenceTransactionId: 'reference-1',
            });

            expect(rollback.ledgerDirectionFor(bet)).toBe(
                LedgerEntryDirection.CREDIT,
            );

            expect(rollback.ledgerDirectionFor(win)).toBe(
                LedgerEntryDirection.DEBIT,
            );
        });

        it('rejects ROLLBACK without a reference transaction', () => {
            const rollback = WagerTransaction.create({
                ...validProps(),
                type: WagerTransactionType.ROLLBACK,
                referenceTransactionId: 'reference-1',
            });

            expect(() => rollback.ledgerDirectionFor()).toThrow(
                'ROLLBACK requires a reference transaction.',
            );
        });

        it('rejects ROLLBACK referencing LOSS', () => {
            const loss = WagerTransaction.create({
                ...validProps(),
                type: WagerTransactionType.LOSS,
            });

            const rollback = WagerTransaction.create({
                ...validProps(),
                type: WagerTransactionType.ROLLBACK,
                referenceTransactionId: 'reference-1',
            });

            expect(() => rollback.ledgerDirectionFor(loss)).toThrow();
        });
    });

    describe('response balance', () => {
        it('registers a valid response balance', () => {
            const transaction = WagerTransaction.create(validProps());

            transaction.setResponseBalance(Money.create('70.00', 'BRL'));

            expect(transaction.responseBalance?.toString()).toBe('70.00');
        });

        it('returns the registered response balance', () => {
            const transaction = WagerTransaction.create(validProps());
            const balance = Money.create('70.00', 'BRL');

            transaction.setResponseBalance(balance);

            expect(transaction.responseBalance).toBe(balance);
        });

        it('rejects a response balance with a different currency', () => {
            const transaction = WagerTransaction.create(validProps());

            expect(() =>
                transaction.setResponseBalance(Money.create('70.00', 'USD')),
            ).toThrow();
        });

        it('rejects a negative response balance', () => {
            const transaction = WagerTransaction.create(validProps());

            expect(() =>
                transaction.setResponseBalance(Money.create('-10.00', 'BRL')),
            ).toThrow();
        });

        it('does not allow changing response balance after PROCESSED', () => {
            const transaction = WagerTransaction.create(validProps());

            transaction.markProcessed();

            expect(() =>
                transaction.setResponseBalance(Money.create('70.00', 'BRL')),
            ).toThrow();
        });
    });

    describe('reference retry metadata', () => {
        it('starts with zero reference attempts', () => {
            const transaction = WagerTransaction.create(validProps());

            expect(transaction.referenceAttempts).toBe(0);
            expect(transaction.nextReferenceAttemptAt).toBeUndefined();
            expect(transaction.referenceExpiresAt).toBeUndefined();
        });

        it('initializes the reference retry schedule', () => {
            const transaction = WagerTransaction.create(validProps());

            const nextAttemptAt = new Date('2026-11-19T00:00:05.000Z');
            const expiresAt = new Date('2026-11-20T00:00:00.000Z');

            transaction.markPendingReference();
            transaction.initializeReferenceRetrySchedule(
                nextAttemptAt,
                expiresAt,
            );

            expect(transaction.referenceAttempts).toBe(0);
            expect(transaction.nextReferenceAttemptAt).toEqual(nextAttemptAt);
            expect(transaction.referenceExpiresAt).toEqual(expiresAt);
        });

        it('records a reference attempt and updates the next attempt date', () => {
            const transaction = WagerTransaction.create(validProps());

            const nextAttemptAt = new Date('2026-11-19T00:00:05.000Z');
            const expirationAt = new Date('2026-11-20T00:00:00.000Z');

            transaction.markPendingReference();
            transaction.initializeReferenceRetrySchedule(
                nextAttemptAt,
                expirationAt,
            );

            const secondAttemptAt = new Date('2026-11-19T00:00:15.000Z');

            transaction.recordReferenceAttempt(secondAttemptAt);

            expect(transaction.referenceAttempts).toBe(1);
            expect(transaction.nextReferenceAttemptAt).toEqual(secondAttemptAt);
            expect(transaction.referenceExpiresAt).toEqual(expirationAt);
        });

        it('does not expose mutable internal dates', () => {
            const transaction = WagerTransaction.create(validProps());

            const nextAttemptAt = new Date('2026-11-19T00:00:05.000Z');
            const expirationAt = new Date('2026-11-20T00:00:00.000Z');

            transaction.markPendingReference();
            transaction.initializeReferenceRetrySchedule(
                nextAttemptAt,
                expirationAt,
            );

            transaction.nextReferenceAttemptAt?.setFullYear(2030);
            transaction.referenceExpiresAt?.setFullYear(2030);

            expect(transaction.nextReferenceAttemptAt).toEqual(nextAttemptAt);
            expect(transaction.referenceExpiresAt).toEqual(expirationAt);
        });

        it('rejects an invalid retry schedule', () => {
            const transaction = WagerTransaction.create(validProps());

            transaction.markPendingReference();

            expect(() =>
                transaction.initializeReferenceRetrySchedule(
                    new Date('invalid'),
                    new Date('2026-11-20T00:00:00.000Z'),
                ),
            ).toThrow();

            expect(() =>
                transaction.initializeReferenceRetrySchedule(
                    new Date('2026-11-20T00:00:00.000Z'),
                    new Date('2026-11-19T00:00:00.000Z'),
                ),
            ).toThrow();
        });

        it('rejects recording an attempt without an expiration date', () => {
            const transaction = WagerTransaction.create(validProps());

            transaction.markPendingReference();

            expect(() =>
                transaction.recordReferenceAttempt(
                    new Date('2026-11-19T00:00:05.000Z'),
                ),
            ).toThrow();
        });

        it('restores retry metadata when rehydrating', () => {
            const nextAttemptAt = new Date('2026-11-19T00:00:05.000Z');
            const expiresAt = new Date('2026-11-20T00:00:00.000Z');

            const transaction = WagerTransaction.rehydrate({
                ...validProps(),
                status: WagerTransactionStatus.PENDING_REFERENCE,
                referenceAttempts: 3,
                nextReferenceAttemptAt: nextAttemptAt,
                referenceExpiresAt: expiresAt,
            });

            expect(transaction.referenceAttempts).toBe(3);
            expect(transaction.nextReferenceAttemptAt).toEqual(nextAttemptAt);
            expect(transaction.referenceExpiresAt).toEqual(expiresAt);
        });

        it('rejects negative reference attempts during rehydration', () => {
            expect(() =>
                WagerTransaction.rehydrate({
                    ...validProps(),
                    status: WagerTransactionStatus.PENDING_REFERENCE,
                    referenceAttempts: -1,
                }),
            ).toThrow();
        });
    });
});
