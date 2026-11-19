import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';

import mikroOrmConfig from '../../../mikro-orm.config.js';
import { WagerTransactionType } from '../../../src/domain/transactions/wager-transaction-type.js';
import { WagerTransactionStatus } from '../../../src/domain/transactions/wager-transaction-status.js';
import { WagerTransactionFailureCode } from '../../../src/domain/transactions/wager-transaction-failure-code.js';
import { ProcessWagerTransactionUseCase } from '../../../src/application/use-cases/wagering/process-wager-transaction.use-case.js';
import { WalletEntity } from '../../../src/infrastructure/database/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../../../src/infrastructure/database/entities/wager-transaction.entity.js';
import { LedgerEntryEntity } from '../../../src/infrastructure/database/entities/ledger-entry.entity.js';
import { expectLedgerMatchesBalance, openWallet } from '../../support/wallet-invariants.js';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/database/unit-of-work/mikro-orm-unit-of-work.js';

if (process.env.POSTGRES_DB !== 'financial_wallet_test') {
    throw new Error(
        'Integration tests must run against financial_wallet_test.',
    );
}

describe('Refund concurrency integration', () => {
    let orm: MikroORM;
    let unitOfWork: MikroOrmUnitOfWork;
    let useCase: ProcessWagerTransactionUseCase;

    beforeAll(async () => {
        orm = await MikroORM.init(mikroOrmConfig);
        unitOfWork = new MikroOrmUnitOfWork(orm.em);
        useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    });

    afterAll(async () => {
        await orm.close(true);
    });

    it('prevents two concurrent refunds from reversing the same BET', async () => {
        const walletId = randomUUID();
        const playerId = `player-${walletId}`;
        const providerId = 'TEST_PROVIDER';
        const betExternalId = `bet-${randomUUID()}`;

        await openWallet(unitOfWork, walletId, playerId, '50.00');

        const bet = await useCase.execute({
            providerId,
            externalTransactionId: betExternalId,
            idempotencyKey: `bet-key-${randomUUID()}`,
            playerId,
            walletId,
            roundId: 'round-1',
            gameId: 'game-1',
            kind: WagerTransactionType.BET,
            money: {
                amount: '25.00',
                currency: 'BRL',
            },
        });

        expect(bet.status).toBe(WagerTransactionStatus.PROCESSED);
        expect(bet.balance?.amount).toBe('25.00');

        const refund = (externalTransactionId: string) =>
            useCase.execute({
                providerId,
                externalTransactionId,
                idempotencyKey: `refund-key-${randomUUID()}`,
                playerId,
                walletId,
                roundId: 'round-1',
                gameId: 'game-1',
                kind: WagerTransactionType.REFUND,
                referenceExternalTransactionId: betExternalId,
                money: {
                    amount: '25.00',
                    currency: 'BRL',
                },
            });

        const results = await Promise.all([
            refund(`refund-a-${randomUUID()}`),
            refund(`refund-b-${randomUUID()}`),
        ]);

        const processedRefunds = results.filter(
            (result) => result.status === WagerTransactionStatus.PROCESSED,
        );

        const rejectedRefunds = results.filter(
            (result) => result.status === WagerTransactionStatus.REJECTED,
        );

        expect(processedRefunds).toHaveLength(1);
        expect(rejectedRefunds).toHaveLength(1);

        expect(rejectedRefunds[0]?.failureCode).toBe(
            WagerTransactionFailureCode.REFERENCE_ALREADY_REVERSED,
        );

        expect(processedRefunds[0]?.balance?.amount).toBe('50.00');

        // Invariante final: saldo materializado == saldo reconstruído pelo ledger.
        await expectLedgerMatchesBalance(orm, walletId);

        const verificationEm = orm.em.fork();

        try {
            const persistedWallet = await verificationEm.findOne(WalletEntity, {
                id: walletId,
            });

            expect(persistedWallet).not.toBeNull();
            expect(persistedWallet!.balance).toBe('50.00');

            const persistedRefunds = await verificationEm.find(
                WagerTransactionEntity,
                {
                    walletId,
                    type: WagerTransactionType.REFUND,
                },
            );

            expect(persistedRefunds).toHaveLength(2);

            expect(
                persistedRefunds.filter(
                    (transaction) =>
                        transaction.status === WagerTransactionStatus.PROCESSED,
                ),
            ).toHaveLength(1);

            expect(
                persistedRefunds.filter(
                    (transaction) =>
                        transaction.status === WagerTransactionStatus.REJECTED,
                ),
            ).toHaveLength(1);

            const processedRefund = persistedRefunds.find(
                (transaction) =>
                    transaction.status === WagerTransactionStatus.PROCESSED,
            );

            const persistedBet = await verificationEm.findOneOrFail(
                WagerTransactionEntity,
                {
                    providerId,
                    providerTransactionId: betExternalId,
                },
            );

            expect(processedRefund?.referenceTransactionId).toBe(
                persistedBet.id,
            );

            const refundLedgerEntries = await verificationEm.find(
                LedgerEntryEntity,
                {
                    walletId,
                    transactionId: processedRefund!.id,
                },
            );

            expect(refundLedgerEntries).toHaveLength(1);
            expect(refundLedgerEntries[0]?.direction).toBe('CREDIT');
            expect(refundLedgerEntries[0]?.amount).toBe('25.00');
            expect(refundLedgerEntries[0]?.balanceBefore).toBe('25.00');
            expect(refundLedgerEntries[0]?.balanceAfter).toBe('50.00');
        } finally {
            verificationEm.clear();
        }
    });
});
