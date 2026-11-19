import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';

import mikroOrmConfig from '../../../mikro-orm.config.js';
import { Wallet } from '../../../src/domain/wallets/wallet.js';
import type { TransactionRepositories, UnitOfWork } from '../../../src/application/ports/unit-of-work.js';
import { ProcessWagerTransactionUseCase } from '../../../src/application/use-cases/wagering/process-wager-transaction.use-case.js';
import { ReferenceRetryPolicy } from '../../../src/domain/transactions/reference-retry-policy.js';
import { WagerTransactionType } from '../../../src/domain/transactions/wager-transaction-type.js';
import { WagerTransactionStatus } from '../../../src/domain/transactions/wager-transaction-status.js';
import { WalletEntity } from '../../../src/infrastructure/database/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../../../src/infrastructure/database/entities/wager-transaction.entity.js';
import { LedgerEntryEntity } from '../../../src/infrastructure/database/entities/ledger-entry.entity.js';
import { OutboxEventEntity } from '../../../src/infrastructure/database/entities/outbox-event.entity.js';
import { InboxMessageEntity } from '../../../src/infrastructure/database/entities/inbox-message.entity.js';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/database/unit-of-work/mikro-orm-unit-of-work.js';
import { expectLedgerMatchesBalance, openWallet } from '../../support/wallet-invariants.js';

if (process.env.POSTGRES_DB !== 'financial_wallet_test') {
    throw new Error(
        'Integration tests must run against financial_wallet_test.',
    );
}

/** UoW que executa toda a operação e falha DEPOIS dela, imediatamente antes do COMMIT. */
class CrashBeforeCommitUnitOfWork implements UnitOfWork {
    constructor(private readonly inner: UnitOfWork) {}

    execute<T>(operation: (repositories: TransactionRepositories) => Promise<T>): Promise<T> {
        return this.inner.execute(async (repositories) => {
            await operation(repositories);
            throw new Error('process crashed before COMMIT');
        });
    }
}

describe('MikroOrmUnitOfWork integration (atomicidade wallet + transação + ledger + inbox + outbox)', () => {
    let orm: MikroORM;
    let unitOfWork: MikroOrmUnitOfWork;

    beforeAll(async () => {
        orm = await MikroORM.init(mikroOrmConfig);
        unitOfWork = new MikroOrmUnitOfWork(orm.em);
    });

    afterAll(async () => {
        await orm.close(true);
    });

    const bet = (walletId: string, playerId: string) => ({
        providerId: 'provider-atomic',
        externalTransactionId: `bet-${randomUUID()}`,
        idempotencyKey: `provider-atomic:${randomUUID()}`,
        playerId,
        walletId,
        roundId: 'round-atomic',
        gameId: 'game-atomic',
        kind: WagerTransactionType.BET,
        money: { amount: '30.00', currency: 'BRL' },
    });

    const inboxContext = (messageId: string, input: object) => ({
        consumerName: 'atomicity-consumer',
        messageId,
        payloadHash: 'a'.repeat(64),
        payload: input as Record<string, unknown>,
    });

    async function snapshot(walletId: string, input: { providerId: string; externalTransactionId: string }, messageId: string) {
        const em = orm.em.fork();
        try {
            const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });
            const tx = await em.findOne(WagerTransactionEntity, {
                providerId: input.providerId,
                providerTransactionId: input.externalTransactionId,
            });
            return {
                balance: wallet.balance,
                version: wallet.version,
                transaction: tx,
                ledger: await em.count(LedgerEntryEntity, { walletId }),
                outbox: tx ? await em.count(OutboxEventEntity, { aggregateId: { $in: [tx.id, walletId] } }) : await em.count(OutboxEventEntity, { aggregateId: walletId }),
                inbox: await em.findOne(InboxMessageEntity, { consumerName: 'atomicity-consumer', messageId }),
            };
        } finally {
            em.clear();
        }
    }

    it('rolls back all database changes when the operation fails', async () => {
        const walletId = randomUUID();
        const playerId = `player-${walletId}`;
        const wallet = Wallet.create(walletId, playerId, 'BRL');

        await expect(
            unitOfWork.execute(async ({ wallets }) => {
                await wallets.save(wallet);
                throw new Error('Simulated operation failure');
            }),
        ).rejects.toThrow('Simulated operation failure');

        const em = orm.em.fork();
        expect(await em.findOne(WalletEntity, { id: walletId })).toBeNull();
        em.clear();
    });

    it('crash antes do COMMIT: nada é confirmado (saldo, transação, ledger, inbox e outbox)', async () => {
        const walletId = randomUUID();
        const playerId = `player-${walletId}`;
        await openWallet(unitOfWork, walletId, playerId, '100.00');

        const input = bet(walletId, playerId);
        const messageId = `msg-${randomUUID()}`;
        const crashing = new ProcessWagerTransactionUseCase(
            new CrashBeforeCommitUnitOfWork(unitOfWork),
            new ReferenceRetryPolicy(),
        );

        await expect(crashing.execute(input, inboxContext(messageId, input))).rejects.toThrow(
            'process crashed before COMMIT',
        );

        const state = await snapshot(walletId, input, messageId);
        expect(state.balance).toBe('100.00');
        expect(state.version).toBe(1);
        expect(state.transaction).toBeNull();
        expect(state.ledger).toBe(1); // só o OPENING
        expect(state.outbox).toBe(0);
        expect(state.inbox).toBeNull();
        await expectLedgerMatchesBalance(orm, walletId);

        // A reentrega (mesmo messageId) depois do crash aplica o efeito UMA vez.
        const healthy = new ProcessWagerTransactionUseCase(unitOfWork, new ReferenceRetryPolicy());
        const output = await healthy.execute(input, inboxContext(messageId, input));
        expect(output.status).toBe(WagerTransactionStatus.PROCESSED);

        const after = await snapshot(walletId, input, messageId);
        expect(after.balance).toBe('70.00');
        expect(after.version).toBe(2);
        expect(after.transaction?.status as string).toBe('PROCESSED');
        expect(after.ledger).toBe(2);
        // WagerTransactionProcessed + WalletBalanceChanged, gravados no mesmo commit.
        expect(after.outbox).toBe(2);
        expect(after.inbox?.status).toBe('PROCESSED');
        await expectLedgerMatchesBalance(orm, walletId);
    });
});
