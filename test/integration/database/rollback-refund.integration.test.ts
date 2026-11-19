import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { expectLedgerMatchesBalance, openWallet } from '../../support/wallet-invariants.js';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/database/unit-of-work/mikro-orm-unit-of-work.js';
import { ProcessWagerTransactionUseCase } from '../../../src/application/use-cases/wagering/process-wager-transaction.use-case.js';
import mikroOrmConfig from '../../../mikro-orm.config.js';
import { WagerTransactionType } from '../../../src/domain/transactions/wager-transaction-type.js';
import { WagerTransactionStatus } from '../../../src/domain/transactions/wager-transaction-status.js';
import { WalletEntity } from '../../../src/infrastructure/database/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../../../src/infrastructure/database/entities/wager-transaction.entity.js';
import { LedgerEntryEntity } from '../../../src/infrastructure/database/entities/ledger-entry.entity.js';

if (process.env.POSTGRES_DB !== 'financial_wallet_test') {
    throw new Error(
        'Integration tests must run against financial_wallet_test.',
    );
}

describe('Rollback REFUND integration', () => {
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

    it('debits the wallet and creates a DEBIT ledger entry when rolling back a REFUND', async () => {
        const walletId = randomUUID();
        const playerId = `player-${walletId}`;
        const providerId = 'TEST_PROVIDER';
        const betExternalId = `bet-${randomUUID()}`;
        const refundExternalId = `refund-${randomUUID()}`;
        const rollbackExternalId = `rollback-${randomUUID()}`;

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

        const refund = await useCase.execute({
            providerId,
            externalTransactionId: refundExternalId,
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

        expect(refund.status).toBe(WagerTransactionStatus.PROCESSED);
        expect(refund.balance?.amount).toBe('50.00');

        const rollback = await useCase.execute({
            providerId,
            externalTransactionId: rollbackExternalId,
            idempotencyKey: `rollback-key-${randomUUID()}`,
            playerId,
            walletId,
            roundId: 'round-1',
            gameId: 'game-1',
            kind: WagerTransactionType.ROLLBACK,
            referenceExternalTransactionId: refundExternalId,
            money: {
                amount: '25.00',
                currency: 'BRL',
            },
        });

        expect(rollback.status).toBe(WagerTransactionStatus.PROCESSED);
        expect(rollback.balance?.amount).toBe('25.00');

        // Invariante final: saldo materializado == saldo reconstruído pelo ledger.
        await expectLedgerMatchesBalance(orm, walletId);

        const verificationEm = orm.em.fork();

        try {
            const persistedWallet = await verificationEm.findOne(WalletEntity, {
                id: walletId,
            });

            expect(persistedWallet).not.toBeNull();
            expect(persistedWallet!.balance).toBe('25.00');

            const persistedRefund = await verificationEm.findOneOrFail(
                WagerTransactionEntity,
                {
                    providerId,
                    providerTransactionId: refundExternalId,
                },
            );

            const persistedRollback = await verificationEm.findOneOrFail(
                WagerTransactionEntity,
                {
                    providerId,
                    providerTransactionId: rollbackExternalId,
                },
            );

            expect(persistedRollback.type).toBe(WagerTransactionType.ROLLBACK);
            expect(persistedRollback.status).toBe(
                WagerTransactionStatus.PROCESSED,
            );
            expect(persistedRollback.referenceTransactionId).toBe(
                persistedRefund.id,
            );

            const rollbackLedgerEntries = await verificationEm.find(
                LedgerEntryEntity,
                {
                    walletId,
                    transactionId: persistedRollback.id,
                },
            );

            expect(rollbackLedgerEntries).toHaveLength(1);
            expect(rollbackLedgerEntries[0]?.direction).toBe('DEBIT');
            expect(rollbackLedgerEntries[0]?.amount).toBe('25.00');
            expect(rollbackLedgerEntries[0]?.balanceBefore).toBe('50.00');
            expect(rollbackLedgerEntries[0]?.balanceAfter).toBe('25.00');

            const allWalletLedgerEntries = await verificationEm.find(
                LedgerEntryEntity,
                {
                    walletId,
                },
            );

            expect(allWalletLedgerEntries).toHaveLength(4); // OPENING + BET + REFUND + ROLLBACK
        } finally {
            verificationEm.clear();
        }
    });
});
