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

describe('Rollback concurrency integration', () => {
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

    it('prevents two concurrent ROLLBACKs from reversing the same BET', async () => {
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

        const rollback = (externalTransactionId: string) =>
            useCase.execute({
                providerId,
                externalTransactionId,
                idempotencyKey: `rollback-key-${randomUUID()}`,
                playerId,
                walletId,
                roundId: 'round-1',
                gameId: 'game-1',
                kind: WagerTransactionType.ROLLBACK,
                referenceExternalTransactionId: betExternalId,
                money: {
                    amount: '25.00',
                    currency: 'BRL',
                },
            });

        const results = await Promise.all([
            rollback(`rollback-a-${randomUUID()}`),
            rollback(`rollback-b-${randomUUID()}`),
        ]);

        const processedRollbacks = results.filter(
            (result) => result.status === WagerTransactionStatus.PROCESSED,
        );

        const rejectedRollbacks = results.filter(
            (result) => result.status === WagerTransactionStatus.REJECTED,
        );

        expect(processedRollbacks).toHaveLength(1);
        expect(rejectedRollbacks).toHaveLength(1);

        expect(rejectedRollbacks[0]?.failureCode).toBe(
            WagerTransactionFailureCode.REFERENCE_ALREADY_REVERSED,
        );

        expect(processedRollbacks[0]?.balance?.amount).toBe('50.00');

        // Invariante final: saldo materializado == saldo reconstruído pelo ledger.
        await expectLedgerMatchesBalance(orm, walletId);

        const verificationEm = orm.em.fork();

        try {
            const persistedWallet = await verificationEm.findOne(WalletEntity, {
                id: walletId,
            });

            expect(persistedWallet).not.toBeNull();
            expect(persistedWallet!.balance).toBe('50.00');

            const persistedRollbacks = await verificationEm.find(
                WagerTransactionEntity,
                {
                    walletId,
                    type: WagerTransactionType.ROLLBACK,
                },
            );

            expect(persistedRollbacks).toHaveLength(2);

            expect(
                persistedRollbacks.filter(
                    (transaction) =>
                        transaction.status === WagerTransactionStatus.PROCESSED,
                ),
            ).toHaveLength(1);

            expect(
                persistedRollbacks.filter(
                    (transaction) =>
                        transaction.status === WagerTransactionStatus.REJECTED,
                ),
            ).toHaveLength(1);

            const processedRollback = persistedRollbacks.find(
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

            expect(processedRollback?.referenceTransactionId).toBe(
                persistedBet.id,
            );

            const rollbackLedgerEntries = await verificationEm.find(
                LedgerEntryEntity,
                {
                    walletId,
                    transactionId: processedRollback!.id,
                },
            );

            expect(rollbackLedgerEntries).toHaveLength(1);
            expect(rollbackLedgerEntries[0]?.direction).toBe('CREDIT');
            expect(rollbackLedgerEntries[0]?.amount).toBe('25.00');
            expect(rollbackLedgerEntries[0]?.balanceBefore).toBe('25.00');
            expect(rollbackLedgerEntries[0]?.balanceAfter).toBe('50.00');

            const allWalletLedgerEntries = await verificationEm.find(
                LedgerEntryEntity,
                {
                    walletId,
                },
            );

            expect(allWalletLedgerEntries).toHaveLength(3); // OPENING + BET + um único ROLLBACK
        } finally {
            verificationEm.clear();
        }
    });
});
