import { beforeEach, describe, expect, it } from 'bun:test';

import {
    ExternalTransactionConflictError,
    IdempotencyConflictError,
    ProcessWagerTransactionUseCase,
    WalletNotFoundError,
    WalletOwnershipMismatchError,
} from '../../../../src/application/use-cases/wagering/process-wager-transaction.use-case.js';
import { InboxPayloadMismatchError } from '../../../../src/application/errors/application-errors.js';
import type { ProcessWagerTransactionInput } from '../../../../src/application/use-cases/wagering/dto/process-wager-transaction.input.js';
import { ApplicationValidationError } from '../../../../src/application/errors/application-errors.js';
import { ReferenceRetryPolicy } from '../../../../src/domain/transactions/reference-retry-policy.js';
import { WagerTransactionFailureCode } from '../../../../src/domain/transactions/wager-transaction-failure-code.js';
import { WagerTransactionStatus } from '../../../../src/domain/transactions/wager-transaction-status.js';
import { WagerTransactionType } from '../../../../src/domain/transactions/wager-transaction-type.js';
import { metrics } from '../../../../src/infrastructure/observability/metrics.js';
import { InMemoryDatabase } from '../../../support/in-memory-unit-of-work.js';

const { BET, WIN, LOSS, REFUND, ROLLBACK } = WagerTransactionType;

describe('ProcessWagerTransactionUseCase', () => {
    let db: InMemoryDatabase;
    let useCase: ProcessWagerTransactionUseCase;
    let sequence: number;

    beforeEach(() => {
        db = new InMemoryDatabase();
        useCase = new ProcessWagerTransactionUseCase(db, new ReferenceRetryPolicy());
        sequence = 0;
        metrics.transactionsTotal.reset();
        metrics.duplicatesTotal.reset();
        metrics.idempotencyConflictsTotal.reset();
    });

    /** Monta a entrada de uma operação; a idempotency key default é provider:externalId. */
    function submit(
        wallet: { walletId: string; playerId: string },
        overrides: Partial<ProcessWagerTransactionInput> & { amount?: string; currency?: string } = {},
    ) {
        sequence++;
        const { amount = '25.00', currency = 'BRL', ...rest } = overrides;
        const externalTransactionId = rest.externalTransactionId ?? `tx-${sequence}`;
        const providerId = rest.providerId ?? 'provider-a';
        const input: ProcessWagerTransactionInput = {
            providerId,
            externalTransactionId,
            idempotencyKey: `${providerId}:${externalTransactionId}`,
            playerId: wallet.playerId,
            walletId: wallet.walletId,
            roundId: 'round-1',
            gameId: 'game-1',
            kind: BET,
            money: { amount, currency },
            ...rest,
        };
        return input;
    }

    describe('BET', () => {
        it('debits the wallet, writes one DEBIT ledger entry and enqueues both events', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });

            const result = await useCase.execute(submit(wallet));

            expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
            expect(result.balance).toEqual({ amount: '75.00', currency: 'BRL' });
            expect(result.idempotentReplay).toBe(false);
            expect(db.wallet(wallet.walletId)).toEqual({ balance: '75.00', version: 2 });

            const ledger = db.ledgerOf(wallet.walletId);
            expect(ledger).toHaveLength(2); // OPENING + BET
            expect(ledger[1]!.direction as string).toBe('DEBIT');
            expect(ledger[1]!.walletVersion).toBe(2);
            expect(db.outboxTypes()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
            db.assertWalletMatchesLedger(wallet.walletId);
        });

        it('rejects a BET without funds: no balance change, no ledger entry, rejection event', async () => {
            const wallet = db.seedWallet({ balance: '10.00' });

            const result = await useCase.execute(submit(wallet, { amount: '25.00' }));

            expect(result.status).toBe(WagerTransactionStatus.REJECTED);
            expect(result.failureCode).toBe(WagerTransactionFailureCode.INSUFFICIENT_FUNDS);
            expect(result.balance).toEqual({ amount: '10.00', currency: 'BRL' });
            expect(db.wallet(wallet.walletId)).toEqual({ balance: '10.00', version: 1 });
            expect(db.ledgerOf(wallet.walletId)).toHaveLength(1); // só OPENING
            expect(db.outboxTypes()).toEqual(['WagerTransactionRejected']);
        });

        it('REQUIRED SCENARIO: two simultaneous 80.00 bets on a 100.00 wallet → one wins, one is rejected', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });

            const [a, b] = await Promise.all([
                useCase.execute(submit(wallet, { amount: '80.00' })),
                useCase.execute(submit(wallet, { amount: '80.00' })),
            ]);

            const statuses = [a.status, b.status].sort();
            expect(statuses).toEqual([WagerTransactionStatus.PROCESSED, WagerTransactionStatus.REJECTED]);
            expect(db.wallet(wallet.walletId).balance).toBe('20.00');
            expect(db.ledgerOf(wallet.walletId).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
            db.assertWalletMatchesLedger(wallet.walletId);
        });

        it('never lets the balance go negative under many concurrent bets', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });

            const results = await Promise.all(
                Array.from({ length: 30 }, () => useCase.execute(submit(wallet, { amount: '7.00' }))),
            );

            const processed = results.filter((r) => r.status === WagerTransactionStatus.PROCESSED).length;
            expect(processed).toBe(14); // floor(100 / 7)
            expect(db.wallet(wallet.walletId).balance).toBe('2.00');
            db.assertWalletMatchesLedger(wallet.walletId);
        });

        it('processes different wallets independently', async () => {
            const w1 = db.seedWallet({ balance: '50.00' });
            const w2 = db.seedWallet({ balance: '50.00' });

            await Promise.all([
                useCase.execute(submit(w1, { amount: '50.00' })),
                useCase.execute(submit(w2, { amount: '30.00' })),
            ]);

            expect(db.wallet(w1.walletId).balance).toBe('0.00');
            expect(db.wallet(w2.walletId).balance).toBe('20.00');
        });
    });

    describe('WIN and LOSS', () => {
        it('credits a WIN with one CREDIT ledger entry', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });

            const result = await useCase.execute(submit(wallet, { kind: WIN, amount: '40.00' }));

            expect(result.balance).toEqual({ amount: '140.00', currency: 'BRL' });
            expect(db.ledgerOf(wallet.walletId)[1]!.direction as string).toBe('CREDIT');
            db.assertWalletMatchesLedger(wallet.walletId);
        });

        it('records a LOSS without moving the balance, without ledger, and without WalletBalanceChanged', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });

            const result = await useCase.execute(submit(wallet, { kind: LOSS, amount: '25.00' }));

            expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
            expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
            expect(db.wallet(wallet.walletId)).toEqual({ balance: '100.00', version: 1 }); // versão só muda com o saldo
            expect(db.ledgerOf(wallet.walletId)).toHaveLength(1);
            expect(db.outboxTypes()).toEqual(['WagerTransactionProcessed']);
        });
    });

    describe('idempotency', () => {
        it('replays an identical request with the original result and never debits twice', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            const input = submit(wallet, { amount: '25.00' });

            const first = await useCase.execute(input);
            const replay = await useCase.execute({ ...input });

            expect(replay.transactionId).toBe(first.transactionId);
            expect(replay.idempotentReplay).toBe(true);
            expect(replay.balance).toEqual(first.balance);
            expect(db.wallet(wallet.walletId).balance).toBe('75.00');
            expect(db.ledgerOf(wallet.walletId)).toHaveLength(2);
            expect(metrics.duplicatesTotal.total()).toBe(1);
        });

        it('returns the ORIGINAL balance on replay even after later operations changed the wallet', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            const first = await useCase.execute(submit(wallet, { amount: '25.00' }));
            await useCase.execute(submit(wallet, { kind: WIN, amount: '500.00' }));

            const replay = await useCase.execute(submit(wallet, { amount: '25.00', externalTransactionId: 'tx-1' }));

            expect(replay.idempotentReplay).toBe(true);
            expect(replay.balance).toEqual(first.balance); // 75.00, não 575.00
        });

        it('replays a REJECTED outcome as rejected (same failure code)', async () => {
            const wallet = db.seedWallet({ balance: '10.00' });
            const input = submit(wallet, { amount: '25.00' });
            await useCase.execute(input);

            const replay = await useCase.execute(input);

            expect(replay.idempotentReplay).toBe(true);
            expect(replay.status).toBe(WagerTransactionStatus.REJECTED);
            expect(replay.failureCode).toBe(WagerTransactionFailureCode.INSUFFICIENT_FUNDS);
        });

        it('treats 50 parallel submissions of the same request as ONE debit', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            const input = submit(wallet, { amount: '10.00' });

            const results = await Promise.all(Array.from({ length: 50 }, () => useCase.execute({ ...input })));

            expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
            expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
            expect(db.wallet(wallet.walletId).balance).toBe('90.00');
            expect(db.ledgerOf(wallet.walletId)).toHaveLength(2);
            db.assertWalletMatchesLedger(wallet.walletId);
        });

        it('rejects the same idempotency key with a DIFFERENT payload as a conflict, not a replay', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            const input = submit(wallet, { amount: '25.00' });
            await useCase.execute(input);

            await expect(useCase.execute({ ...input, money: { amount: '26.00', currency: 'BRL' } }))
                .rejects.toBeInstanceOf(IdempotencyConflictError);
            expect(db.wallet(wallet.walletId).balance).toBe('75.00');
            expect(metrics.idempotencyConflictsTotal.total()).toBe(1);
        });

        it('rejects a reused provider transaction id under a different idempotency key', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            await useCase.execute(submit(wallet, { externalTransactionId: 'tx-x' }));

            await expect(
                useCase.execute(submit(wallet, { externalTransactionId: 'tx-x', idempotencyKey: 'another-key' })),
            ).rejects.toBeInstanceOf(ExternalTransactionConflictError);
        });

        it('hashes the canonical business payload: amount "25" and "25.00" are the same request', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            const first = await useCase.execute(submit(wallet, { amount: '25', externalTransactionId: 'tx-n' }));

            const replay = await useCase.execute(submit(wallet, { amount: '25.00', externalTransactionId: 'tx-n' }));

            expect(replay.idempotentReplay).toBe(true);
            expect(replay.transactionId).toBe(first.transactionId);
        });

        it('scopes idempotency keys per provider', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            const a = await useCase.execute(submit(wallet, { providerId: 'provider-a', externalTransactionId: 't', idempotencyKey: 'same-key' }));
            const b = await useCase.execute(submit(wallet, { providerId: 'provider-b', externalTransactionId: 't', idempotencyKey: 'same-key' }));

            expect(a.transactionId).not.toBe(b.transactionId);
            expect(db.wallet(wallet.walletId).balance).toBe('50.00');
        });
    });

    describe('REFUND', () => {
        it('credits back a processed BET, once', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            await useCase.execute(submit(wallet, { externalTransactionId: 'bet-1', amount: '25.00' }));

            const refund = await useCase.execute(
                submit(wallet, { kind: REFUND, externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-1', amount: '25.00' }),
            );

            expect(refund.status).toBe(WagerTransactionStatus.PROCESSED);
            expect(refund.balance).toEqual({ amount: '100.00', currency: 'BRL' });
            db.assertWalletMatchesLedger(wallet.walletId);
        });

        it('rejects a second reversal of the same BET (REFERENCE_ALREADY_REVERSED), refund or rollback', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            await useCase.execute(submit(wallet, { externalTransactionId: 'bet-1', amount: '25.00' }));
            await useCase.execute(submit(wallet, { kind: REFUND, externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-1' }));

            const secondRefund = await useCase.execute(
                submit(wallet, { kind: REFUND, externalTransactionId: 'refund-2', referenceExternalTransactionId: 'bet-1' }),
            );
            const rollback = await useCase.execute(
                submit(wallet, { kind: ROLLBACK, externalTransactionId: 'rollback-1', referenceExternalTransactionId: 'bet-1' }),
            );

            expect(secondRefund.failureCode).toBe(WagerTransactionFailureCode.REFERENCE_ALREADY_REVERSED);
            expect(rollback.failureCode).toBe(WagerTransactionFailureCode.REFERENCE_ALREADY_REVERSED);
            expect(db.wallet(wallet.walletId).balance).toBe('100.00');
            db.assertWalletMatchesLedger(wallet.walletId);
        });

        it('lets only ONE of N concurrent refunds of the same BET through', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            await useCase.execute(submit(wallet, { externalTransactionId: 'bet-1', amount: '25.00' }));

            const results = await Promise.all(
                Array.from({ length: 10 }, (_, i) =>
                    useCase.execute(submit(wallet, { kind: REFUND, externalTransactionId: `refund-${i}`, referenceExternalTransactionId: 'bet-1' })),
                ),
            );

            expect(results.filter((r) => r.status === WagerTransactionStatus.PROCESSED)).toHaveLength(1);
            expect(db.wallet(wallet.walletId).balance).toBe('100.00');
        });

        it('rejects a REFUND that references a WIN (REFERENCE_MISMATCH)', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            await useCase.execute(submit(wallet, { kind: WIN, externalTransactionId: 'win-1', amount: '25.00' }));

            const refund = await useCase.execute(
                submit(wallet, { kind: REFUND, externalTransactionId: 'refund-1', referenceExternalTransactionId: 'win-1' }),
            );

            expect(refund.failureCode).toBe(WagerTransactionFailureCode.REFERENCE_MISMATCH);
        });

        it('rejects a reversal whose amount differs from the reference (partial reversals are out of scope)', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            await useCase.execute(submit(wallet, { externalTransactionId: 'bet-1', amount: '25.00' }));

            const refund = await useCase.execute(
                submit(wallet, { kind: REFUND, externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-1', amount: '10.00' }),
            );

            expect(refund.failureCode).toBe(WagerTransactionFailureCode.REFERENCE_MISMATCH);
        });

        it('rejects a reversal for another round or another provider (cannot cross-reference)', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            await useCase.execute(submit(wallet, { externalTransactionId: 'bet-1', roundId: 'round-A' }));

            const otherRound = await useCase.execute(
                submit(wallet, { kind: REFUND, externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-1', roundId: 'round-B' }),
            );
            expect(otherRound.failureCode).toBe(WagerTransactionFailureCode.REFERENCE_MISMATCH);

            // Outro provedor não enxerga a transação do provider-a: vira PENDING_REFERENCE, nunca estorno cruzado.
            const otherProvider = await useCase.execute(
                submit(wallet, { providerId: 'provider-b', kind: REFUND, externalTransactionId: 'refund-2', referenceExternalTransactionId: 'bet-1', roundId: 'round-A' }),
            );
            expect(otherProvider.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
            expect(db.wallet(wallet.walletId).balance).toBe('75.00');
        });
    });

    describe('ROLLBACK', () => {
        it('reverses a BET with a CREDIT', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            await useCase.execute(submit(wallet, { externalTransactionId: 'bet-1', amount: '25.00' }));

            const rollback = await useCase.execute(
                submit(wallet, { kind: ROLLBACK, externalTransactionId: 'rb-1', referenceExternalTransactionId: 'bet-1' }),
            );

            expect(rollback.balance).toEqual({ amount: '100.00', currency: 'BRL' });
            expect(db.ledgerOf(wallet.walletId).at(-1)!.direction as string).toBe('CREDIT');
        });

        it('reverses a WIN with a DEBIT', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            await useCase.execute(submit(wallet, { kind: WIN, externalTransactionId: 'win-1', amount: '40.00' }));

            const rollback = await useCase.execute(
                submit(wallet, { kind: ROLLBACK, externalTransactionId: 'rb-1', referenceExternalTransactionId: 'win-1', amount: '40.00' }),
            );

            expect(rollback.balance).toEqual({ amount: '100.00', currency: 'BRL' });
            expect(db.ledgerOf(wallet.walletId).at(-1)!.direction as string).toBe('DEBIT');
            db.assertWalletMatchesLedger(wallet.walletId);
        });

        it('reverses a REFUND with a DEBIT', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            await useCase.execute(submit(wallet, { externalTransactionId: 'bet-1', amount: '25.00' }));
            await useCase.execute(submit(wallet, { kind: REFUND, externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-1' }));

            const rollback = await useCase.execute(
                submit(wallet, { kind: ROLLBACK, externalTransactionId: 'rb-1', referenceExternalTransactionId: 'refund-1' }),
            );

            expect(rollback.balance).toEqual({ amount: '75.00', currency: 'BRL' });
            db.assertWalletMatchesLedger(wallet.walletId);
        });

        it('uses a DISTINCT failure code when a rollback would make the balance negative', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            await useCase.execute(submit(wallet, { kind: WIN, externalTransactionId: 'win-1', amount: '40.00' }));
            await useCase.execute(submit(wallet, { externalTransactionId: 'bet-1', amount: '130.00' })); // saldo 10.00

            const rollback = await useCase.execute(
                submit(wallet, { kind: ROLLBACK, externalTransactionId: 'rb-1', referenceExternalTransactionId: 'win-1', amount: '40.00' }),
            );

            expect(rollback.status).toBe(WagerTransactionStatus.REJECTED);
            expect(rollback.failureCode).toBe(WagerTransactionFailureCode.ROLLBACK_INSUFFICIENT_FUNDS);
            expect(rollback.failureCode).not.toBe(WagerTransactionFailureCode.INSUFFICIENT_FUNDS);
            expect(db.wallet(wallet.walletId).balance).toBe('10.00');
            db.assertWalletMatchesLedger(wallet.walletId);
        });
    });

    describe('references that arrive out of order', () => {
        it('stores a REFUND whose BET has not arrived as PENDING_REFERENCE (no balance change) and emits an event', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });

            const refund = await useCase.execute(
                submit(wallet, { kind: REFUND, externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-1' }),
            );

            expect(refund.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
            expect(db.wallet(wallet.walletId).balance).toBe('100.00');
            expect(db.outboxTypes()).toEqual(['WagerTransactionPendingReference']);
        });

        it('applies the pending refund once the BET arrives and the retry worker runs', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            await useCase.execute(
                submit(wallet, { kind: REFUND, externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-1' }),
            );
            await useCase.execute(submit(wallet, { externalTransactionId: 'bet-1', amount: '25.00' }));

            const later = new Date(Date.now() + 60_000);
            const output = await db.execute(async (repositories) => {
                const [pending] = await repositories.transactions.findPendingReferences(later, 10);
                return useCase.processPendingReference(repositories, pending!, later);
            });

            expect(output.status).toBe(WagerTransactionStatus.PROCESSED);
            expect(db.wallet(wallet.walletId).balance).toBe('100.00'); // 100 - 25 + 25
            db.assertWalletMatchesLedger(wallet.walletId);
        });

        it('rejects with REFERENCE_EXPIRED when the retry window ends (and emits the rejection event)', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            await useCase.execute(
                submit(wallet, { kind: ROLLBACK, externalTransactionId: 'rb-1', referenceExternalTransactionId: 'ghost' }),
            );

            const afterExpiry = new Date(Date.now() + 25 * 60 * 60 * 1_000);
            const output = await db.execute(async (repositories) => {
                const [pending] = await repositories.transactions.findPendingReferences(afterExpiry, 10);
                return useCase.processPendingReference(repositories, pending!, afterExpiry);
            });

            expect(output.status).toBe(WagerTransactionStatus.REJECTED);
            expect(output.failureCode).toBe(WagerTransactionFailureCode.REFERENCE_EXPIRED);
            expect(db.outboxTypes()).toContain('WagerTransactionRejected');
            expect(db.wallet(wallet.walletId).balance).toBe('100.00');
        });
    });

    describe('validation and ownership', () => {
        it('rejects a currency different from the wallet currency (multi-currency model, BRL wallet)', async () => {
            const wallet = db.seedWallet({ balance: '100.00', currency: 'BRL' });

            await expect(useCase.execute(submit(wallet, { currency: 'USD' })))
                .rejects.toBeInstanceOf(WalletOwnershipMismatchError);
            expect(db.wallet(wallet.walletId).balance).toBe('100.00');
        });

        it('rejects a player that does not own the wallet', async () => {
            const wallet = db.seedWallet();

            await expect(useCase.execute(submit({ walletId: wallet.walletId, playerId: 'intruder' })))
                .rejects.toBeInstanceOf(WalletOwnershipMismatchError);
        });

        it('fails with WalletNotFoundError for an unknown wallet and leaves no trace (rollback)', async () => {
            await expect(useCase.execute(submit({ walletId: crypto.randomUUID(), playerId: 'p' })))
                .rejects.toBeInstanceOf(WalletNotFoundError);
            expect(db.state.transactions.size).toBe(0);
            expect(db.state.outbox).toHaveLength(0);
        });

        it('rejects OPENING (internal only), zero and malformed amounts', async () => {
            const wallet = db.seedWallet();

            await expect(useCase.execute(submit(wallet, { kind: WagerTransactionType.OPENING })))
                .rejects.toBeInstanceOf(ApplicationValidationError);
            await expect(useCase.execute(submit(wallet, { amount: '0.00' })))
                .rejects.toBeInstanceOf(ApplicationValidationError);
            await expect(useCase.execute(submit(wallet, { amount: '1e3' }))).rejects.toThrow();
            await expect(useCase.execute(submit(wallet, { amount: '10.999' }))).rejects.toThrow();
        });

        it('requires a reference for REFUND and ROLLBACK', async () => {
            const wallet = db.seedWallet();

            await expect(useCase.execute(submit(wallet, { kind: REFUND })))
                .rejects.toBeInstanceOf(ApplicationValidationError);
            await expect(useCase.execute(submit(wallet, { kind: ROLLBACK })))
                .rejects.toBeInstanceOf(ApplicationValidationError);
        });
    });

    describe('inbox (SQS entry)', () => {
        const context = (overrides: Partial<{ messageId: string; payloadHash: string }> = {}) => ({
            consumerName: 'wager-transactions-consumer',
            messageId: overrides.messageId ?? 'msg-1',
            payloadHash: overrides.payloadHash ?? 'hash-1',
            payload: { messageId: 'msg-1' },
        });

        it('commits the inbox row together with the financial effect', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });

            await useCase.execute(submit(wallet), context());

            expect(db.inboxStatus('wager-transactions-consumer', 'msg-1')).toBe('PROCESSED');
            expect(db.wallet(wallet.walletId).balance).toBe('75.00');
        });

        it('rolls the inbox row back together with everything else when processing fails', async () => {
            await expect(useCase.execute(submit({ walletId: crypto.randomUUID(), playerId: 'p' }), context()))
                .rejects.toBeInstanceOf(WalletNotFoundError);

            expect(db.inboxStatus('wager-transactions-consumer', 'msg-1')).toBeUndefined();
        });

        it('treats a redelivered message as a replay: no second debit', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            const input = submit(wallet);
            await useCase.execute(input, context());

            const redelivery = await useCase.execute(input, context());

            expect(redelivery.idempotentReplay).toBe(true);
            expect(db.wallet(wallet.walletId).balance).toBe('75.00');
        });

        it('treats the same business request under a NEW message id as an idempotent replay', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            const input = submit(wallet);
            await useCase.execute(input, context({ messageId: 'msg-1' }));

            const resent = await useCase.execute(input, context({ messageId: 'msg-2' }));

            expect(resent.idempotentReplay).toBe(true);
            expect(db.wallet(wallet.walletId).balance).toBe('75.00');
        });

        it('flags the same messageId with a different payload as a poisoned message', async () => {
            const wallet = db.seedWallet({ balance: '100.00' });
            await useCase.execute(submit(wallet), context({ payloadHash: 'hash-1' }));

            await expect(useCase.execute(submit(wallet), context({ payloadHash: 'hash-DIFFERENT' })))
                .rejects.toBeInstanceOf(InboxPayloadMismatchError);
        });
    });

    describe('metrics', () => {
        it('counts new transactions by status and replays separately', async () => {
            const wallet = db.seedWallet({ balance: '30.00' });
            const input = submit(wallet, { amount: '25.00' });
            await useCase.execute(input);
            await useCase.execute(input); // replay
            await useCase.execute(submit(wallet, { amount: '25.00' })); // rejeitada: saldo 5.00

            expect(metrics.transactionsTotal.get({ status: 'PROCESSED', kind: 'BET', source: 'http' })).toBe(1);
            expect(metrics.transactionsTotal.get({ status: 'REJECTED', kind: 'BET', source: 'http' })).toBe(1);
            expect(metrics.duplicatesTotal.get({ source: 'http' })).toBe(1);
        });
    });
});
