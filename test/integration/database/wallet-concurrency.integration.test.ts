import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';

import mikroOrmConfig from '../../../mikro-orm.config.js';
import { Money } from '../../../src/domain/money/money.js';
import { LedgerEntry } from '../../../src/domain/ledger/ledger-entry.js';
import { LedgerEntryDirection } from '../../../src/domain/ledger/ledger-entry-direction.js';
import { WagerTransaction } from '../../../src/domain/transactions/wager-transaction.js';
import { WagerTransactionType } from '../../../src/domain/transactions/wager-transaction-type.js';
import { WalletEntity } from '../../../src/infrastructure/database/entities/wallet.entity.js';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/database/unit-of-work/mikro-orm-unit-of-work.js';
import { expectLedgerMatchesBalance, openWallet } from '../../support/wallet-invariants.js';

if (process.env.POSTGRES_DB !== 'financial_wallet_test') {
    throw new Error(
        'Integration tests must run against financial_wallet_test.',
    );
}

/**
 * Exercita o lock pessimista da wallet (SELECT … FOR UPDATE) diretamente pelos
 * repositórios, com dois clientes (EntityManagers/conexões) distintos, e grava
 * saldo + transação + ledger na mesma unidade de trabalho — como a aplicação.
 */
describe('Wallet concurrency integration', () => {
    let orms: MikroORM[];

    beforeAll(async () => {
        orms = await Promise.all([
            MikroORM.init(mikroOrmConfig),
            MikroORM.init(mikroOrmConfig),
        ]);
    });

    afterAll(async () => {
        await Promise.all(orms.map((orm) => orm.close(true)));
    });

    it('prevents concurrent debits from producing an inconsistent balance', async () => {
        const walletId = randomUUID();
        const playerId = `player-${walletId}`;
        await openWallet(new MikroOrmUnitOfWork(orms[0]!.em), walletId, playerId, '100.00');

        const debit = async (orm: MikroORM, amount: string): Promise<void> => {
            await new MikroOrmUnitOfWork(orm.em).execute(async (repositories) => {
                const wallet = await repositories.wallets.findByIdForUpdate(walletId);
                if (!wallet) throw new Error('Wallet not found.');

                const money = Money.create(amount, 'BRL');
                const balanceBefore = wallet.balance;
                wallet.debit(money); // lança InsufficientFundsError se não houver saldo

                const transaction = WagerTransaction.create({
                    id: randomUUID(),
                    providerId: 'provider-lock',
                    providerTransactionId: `bet-${randomUUID()}`,
                    playerId,
                    walletId,
                    roundId: 'round-lock',
                    gameId: 'game-lock',
                    type: WagerTransactionType.BET,
                    amount: money,
                    idempotencyKey: randomUUID(),
                    requestHash: randomUUID(),
                });
                transaction.setResponseBalance(wallet.balance);
                transaction.markProcessed(new Date());

                await repositories.wallets.save(wallet);
                await repositories.transactions.save(transaction);
                await repositories.ledger.save(
                    LedgerEntry.create({
                        id: randomUUID(),
                        walletId,
                        transactionId: transaction.id,
                        transactionType: WagerTransactionType.BET,
                        direction: LedgerEntryDirection.DEBIT,
                        amount: money,
                        balanceBefore,
                        balanceAfter: wallet.balance,
                        createdAt: new Date().toISOString(),
                        walletVersion: wallet.version,
                    }),
                );
            });
        };

        const results = await Promise.allSettled([
            debit(orms[0]!, '80.00'),
            debit(orms[1]!, '50.00'),
        ]);

        const fulfilled = results.filter((result) => result.status === 'fulfilled');
        const rejected = results.filter((result) => result.status === 'rejected');

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        const failure = rejected[0];
        if (failure?.status === 'rejected') {
            expect(failure.reason).toBeInstanceOf(Error);
            expect(failure.reason.message).toBe('Insufficient wallet balance.');
        }

        const em = orms[0]!.em.fork();
        try {
            const persisted = await em.findOneOrFail(WalletEntity, { id: walletId });
            expect(persisted.balance).toBeOneOf(['20.00', '50.00']);
            expect(persisted.version).toBe(2); // 1 (abertura) + 1 débito
        } finally {
            em.clear();
        }

        // Invariante final: saldo materializado == saldo reconstruído pelo ledger.
        const reconciled = await expectLedgerMatchesBalance(orms[0]!, walletId);
        expect(reconciled.entries).toBe(2); // OPENING + exatamente um débito
    });
});
