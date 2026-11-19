import { describe, expect, it } from 'bun:test';

import { ReferenceRetryWorker } from '../../../../src/application/workers/reference-retry.worker.js';
import { ProcessWagerTransactionUseCase } from '../../../../src/application/use-cases/wagering/process-wager-transaction.use-case.js';
import type {
    TransactionRepositories,
    UnitOfWork,
} from '../../../../src/application/ports/unit-of-work.js';
import { Money } from '../../../../src/domain/money/money.js';
import { Wallet } from '../../../../src/domain/wallets/wallet.js';
import { LedgerEntry } from '../../../../src/domain/ledger/ledger-entry.js';
import { LedgerEntryDirection } from '../../../../src/domain/ledger/ledger-entry-direction.js';
import { WagerTransaction } from '../../../../src/domain/transactions/wager-transaction.js';
import { WagerTransactionStatus } from '../../../../src/domain/transactions/wager-transaction-status.js';
import { WagerTransactionType } from '../../../../src/domain/transactions/wager-transaction-type.js';
import { WagerTransactionFailureCode } from '../../../../src/domain/transactions/wager-transaction-failure-code.js';
import { ReferenceRetryPolicy } from '../../../../src/domain/transactions/reference-retry-policy.js';

function createPending(
    now: Date,
    type: WagerTransactionType = WagerTransactionType.REFUND,
): WagerTransaction {
    const transaction = WagerTransaction.create({
        id: 'pending-1',
        providerId: 'provider-a',
        providerTransactionId: 'reversal-1',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-1',
        gameId: 'game-1',
        type,
        amount: Money.create('25.00', 'BRL'),
        referenceExternalTransactionId: 'original-1',
        idempotencyKey: 'key-reversal-1',
        requestHash: 'a'.repeat(64),
    });

    transaction.markPendingReference();
    transaction.initializeReferenceRetrySchedule(
        new Date(now.getTime() - 1_000),
        new Date(now.getTime() + 60_000),
    );

    return transaction;
}

function createOriginal(
    type: WagerTransactionType = WagerTransactionType.BET,
): WagerTransaction {
    const transaction = WagerTransaction.create({
        id: 'original-id',
        providerId: 'provider-a',
        providerTransactionId: 'original-1',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-1',
        gameId: 'game-1',
        type,
        amount: Money.create('25.00', 'BRL'),
        idempotencyKey: 'key-original',
        requestHash: 'b'.repeat(64),
    });

    transaction.markProcessed();
    return transaction;
}

function createHarness(
    pending: WagerTransaction,
    original: WagerTransaction | null,
    balance = '50.00',
) {
    const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.create(balance, 'BRL'),
    });
    const savedEntries: LedgerEntry[] = [];
    const savedWallets: Wallet[] = [];

    const repositories = {
        wallets: {
            findById: async () => wallet,
            findByPlayerAndCurrency: async () => wallet,
            findByIdForUpdate: async () => wallet,
            existsByPlayerAndCurrency: async () => false,
            save: async (value: Wallet) => savedWallets.push(value),
        },
        transactions: {
            findById: async () => pending,
            findByIdForUpdate: async () => pending,
            findByProviderAndExternalId: async () => original,
            findByProviderAndExternalIdForUpdate: async () => original,
            findByIdempotencyKey: async () => null,
            findByReferenceExternalId: async () => original,
            findByReferenceTransactionIdAndType: async () => null,
            findPendingReferences: async (now: Date) =>
                pending.status === WagerTransactionStatus.PENDING_REFERENCE &&
                pending.nextReferenceAttemptAt!.getTime() <= now.getTime()
                    ? [pending]
                    : [],
            save: async (value: WagerTransaction) => value,
        },
        ledger: {
            findById: async () => null,
            findByTransactionId: async () => null,
            findByWalletId: async () => [],
            countByWalletId: async () => savedEntries.length,
            save: async (entry: LedgerEntry) => savedEntries.push(entry),
        },
    } as unknown as TransactionRepositories;

    const unitOfWork: UnitOfWork = {
        execute: async <T>(
            operation: (repositories: TransactionRepositories) => Promise<T>,
        ) => operation(repositories),
    };

    const retryPolicy = new ReferenceRetryPolicy();
    const processUseCase = new ProcessWagerTransactionUseCase(
        unitOfWork,
        retryPolicy,
    );
    const worker = new ReferenceRetryWorker(
        unitOfWork,
        processUseCase,
        retryPolicy,
    );

    return {
        worker,
        pending,
        wallet,
        savedEntries,
        savedWallets,
    };
}

describe('ReferenceRetryWorker', () => {
    const now = new Date('2026-11-19T12:00:00.000Z');

    it('defers a missing reference and persists the next exponential backoff', async () => {
        const h = createHarness(createPending(now), null);

        const result = await h.worker.processBatch(10, now);

        expect(result).toEqual({
            attempted: 1,
            processed: 0,
            rejected: 0,
            deferred: 1,
            transientErrors: 0,
        });
        expect(h.pending.referenceAttempts).toBe(1);
        expect(h.pending.nextReferenceAttemptAt?.toISOString()).toBe(
            '2026-11-19T12:00:10.000Z',
        );
        expect(h.wallet.balance.toString()).toBe('50.00');
        expect(h.savedEntries).toHaveLength(0);
    });

    it('processes a pending REFUND when the original BET appears', async () => {
        const h = createHarness(
            createPending(now, WagerTransactionType.REFUND),
            createOriginal(WagerTransactionType.BET),
        );

        const result = await h.worker.processBatch(10, now);

        expect(result.processed).toBe(1);
        expect(h.pending.status).toBe(WagerTransactionStatus.PROCESSED);
        expect(h.pending.referenceTransactionId).toBe('original-id');
        expect(h.wallet.balance.toString()).toBe('75.00');
        expect(h.savedEntries).toHaveLength(1);
        expect(h.savedEntries[0].direction).toBe(LedgerEntryDirection.CREDIT);
    });

    it('processes a pending ROLLBACK when the original WIN appears', async () => {
        const h = createHarness(
            createPending(now, WagerTransactionType.ROLLBACK),
            createOriginal(WagerTransactionType.WIN),
            '50.00',
        );

        const result = await h.worker.processBatch(10, now);

        expect(result.processed).toBe(1);
        expect(h.pending.status).toBe(WagerTransactionStatus.PROCESSED);
        expect(h.pending.referenceTransactionId).toBe('original-id');
        expect(h.wallet.balance.toString()).toBe('25.00');
        expect(h.savedEntries).toHaveLength(1);
        expect(h.savedEntries[0].direction).toBe(LedgerEntryDirection.DEBIT);
    });

    it('records a backoff after a transient infrastructure failure', async () => {
        let persisted = createPending(now);
        let failReferenceLookup = true;

        const wallet = Wallet.open({
            id: 'wallet-1',
            playerId: 'player-1',
            initialBalance: Money.create('50.00', 'BRL'),
        });

        const clonePending = (source: WagerTransaction) =>
            WagerTransaction.rehydrate({
                id: source.id,
                providerId: source.providerId,
                providerTransactionId: source.providerTransactionId,
                playerId: source.playerId,
                walletId: source.walletId,
                roundId: source.roundId,
                gameId: source.gameId,
                type: source.type,
                amount: source.amount,
                referenceTransactionId: source.referenceTransactionId,
                referenceExternalTransactionId:
                    source.referenceExternalTransactionId,
                idempotencyKey: source.idempotencyKey,
                requestHash: source.requestHash,
                status: source.status,
                referenceAttempts: source.referenceAttempts,
                nextReferenceAttemptAt: source.nextReferenceAttemptAt,
                referenceExpiresAt: source.referenceExpiresAt,
            });

        const unitOfWork: UnitOfWork = {
            execute: async <T>(
                operation: (
                    repositories: TransactionRepositories,
                ) => Promise<T>,
            ): Promise<T> => {
                let working = clonePending(persisted);

                const repositories = {
                    wallets: {
                        findById: async () => wallet,
                        findByPlayerAndCurrency: async () => wallet,
                        findByIdForUpdate: async () => wallet,
                        existsByPlayerAndCurrency: async () => false,
                        save: async () => undefined,
                    },
                    transactions: {
                        findById: async () => working,
                        findByIdForUpdate: async () => working,
                        findByProviderAndExternalId: async () => null,
                        findByProviderAndExternalIdForUpdate: async () => {
                            if (failReferenceLookup) {
                                failReferenceLookup = false;
                                throw new Error('temporary database failure');
                            }
                            return null;
                        },
                        findByIdempotencyKey: async () => null,
                        findByReferenceExternalId: async () => null,
                        findByReferenceTransactionIdAndType: async () => null,
                        findPendingReferences: async (at: Date) =>
                            working.status ===
                                WagerTransactionStatus.PENDING_REFERENCE &&
                            working.nextReferenceAttemptAt!.getTime() <=
                                at.getTime()
                                ? [working]
                                : [],
                        save: async (transaction: WagerTransaction) => {
                            working = transaction;
                        },
                    },
                    ledger: {
                        findById: async () => null,
                        findByTransactionId: async () => null,
                        findByWalletId: async () => [],
                        countByWalletId: async () => 0,
                        save: async () => undefined,
                    },
                } as unknown as TransactionRepositories;

                const result = await operation(repositories);
                persisted = working;
                return result;
            },
        };

        const policy = new ReferenceRetryPolicy();
        const processor = new ProcessWagerTransactionUseCase(
            unitOfWork,
            policy,
        );
        const worker = new ReferenceRetryWorker(unitOfWork, processor, policy);

        const result = await worker.processBatch(10, now);

        expect(result.transientErrors).toBe(1);
        expect(result.attempted).toBe(1);
        expect(persisted.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
        expect(persisted.referenceAttempts).toBe(1);
        expect(persisted.nextReferenceAttemptAt?.toISOString()).toBe(
            '2026-11-19T12:00:10.000Z',
        );
    });

    it('rejects an expired pending reference permanently', async () => {
        const pending = createPending(now);
        const expired = WagerTransaction.rehydrate({
            id: pending.id,
            providerId: pending.providerId,
            providerTransactionId: pending.providerTransactionId,
            playerId: pending.playerId,
            walletId: pending.walletId,
            roundId: pending.roundId,
            gameId: pending.gameId,
            type: pending.type,
            amount: pending.amount,
            idempotencyKey: pending.idempotencyKey,
            requestHash: pending.requestHash,
            referenceExternalTransactionId:
                pending.referenceExternalTransactionId,
            status: WagerTransactionStatus.PENDING_REFERENCE,
            referenceAttempts: 0,
            nextReferenceAttemptAt: new Date(now.getTime() - 1_000),
            referenceExpiresAt: new Date(now.getTime() - 1),
        });
        const h = createHarness(expired, null);

        const result = await h.worker.processBatch(10, now);

        expect(result.rejected).toBe(1);
        expect(h.pending.status).toBe(WagerTransactionStatus.REJECTED);
        expect(h.pending.failureCode).toBe(
            WagerTransactionFailureCode.REFERENCE_EXPIRED,
        );
    });

    it('rejects a reference that has already been processed with an incompatible type', async () => {
        const h = createHarness(
            createPending(now, WagerTransactionType.REFUND),
            createOriginal(WagerTransactionType.WIN),
        );

        const result = await h.worker.processBatch(10, now);

        expect(result.rejected).toBe(1);
        expect(h.pending.status).toBe(WagerTransactionStatus.REJECTED);
        expect(h.pending.failureCode).toBe(
            WagerTransactionFailureCode.REFERENCE_MISMATCH,
        );
        expect(h.wallet.balance.toString()).toBe('50.00');
        expect(h.savedEntries).toHaveLength(0);
    });
});
