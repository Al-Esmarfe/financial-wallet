import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';

import mikroOrmConfig from '../../../mikro-orm.config.js';
import { ProcessWagerTransactionUseCase } from '../../../src/application/use-cases/wagering/process-wager-transaction.use-case.js';
import { ReferenceRetryWorker } from '../../../src/application/workers/reference-retry.worker.js';
import { ReferenceRetryPolicy } from '../../../src/domain/transactions/reference-retry-policy.js';
import { WagerTransactionType } from '../../../src/domain/transactions/wager-transaction-type.js';
import { WagerTransactionStatus } from '../../../src/domain/transactions/wager-transaction-status.js';
import { WagerTransactionFailureCode } from '../../../src/domain/transactions/wager-transaction-failure-code.js';
import { WagerTransactionEntity } from '../../../src/infrastructure/database/entities/wager-transaction.entity.js';
import { LedgerEntryEntity } from '../../../src/infrastructure/database/entities/ledger-entry.entity.js';
import { OutboxEventEntity } from '../../../src/infrastructure/database/entities/outbox-event.entity.js';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/database/unit-of-work/mikro-orm-unit-of-work.js';
import { expectLedgerMatchesBalance, openWallet } from '../../support/wallet-invariants.js';

if (process.env.POSTGRES_DB !== 'financial_wallet_test') {
    throw new Error('Integration tests must run against financial_wallet_test.');
}

/**
 * Seção 7.1 com PostgreSQL real: REFUND/ROLLBACK entregues ANTES da transação
 * referenciada ficam PENDING_REFERENCE e o ReferenceRetryWorker os aplica quando
 * a referência chega — ou os rejeita com REFERENCE_EXPIRED ao fim do TTL.
 */
describe('Referências fora de ordem (PostgreSQL real + ReferenceRetryWorker)', () => {
    let orms: MikroORM[];
    const policy = new ReferenceRetryPolicy();

    beforeAll(async () => {
        orms = await Promise.all([MikroORM.init(mikroOrmConfig), MikroORM.init(mikroOrmConfig)]);
    });

    afterAll(async () => {
        await Promise.all(orms.map((orm) => orm.close(true)));
    });

    const uow = (index = 0) => new MikroOrmUnitOfWork(orms[index]!.em);
    const useCase = (index = 0) => new ProcessWagerTransactionUseCase(uow(index), policy);
    const worker = (index = 0) => new ReferenceRetryWorker(uow(index), useCase(index), policy);
    /** Um instante em que a primeira retentativa (5 s) já venceu, mas o TTL (24 h) não. */
    const soon = () => new Date(Date.now() + 60_000);

    async function newWallet(balance = '100.00') {
        const walletId = randomUUID();
        const playerId = `player-${walletId}`;
        await openWallet(uow(), walletId, playerId, balance);
        return { walletId, playerId };
    }

    const command = (
        w: { walletId: string; playerId: string },
        kind: WagerTransactionType,
        externalTransactionId: string,
        amount: string,
        referenceExternalTransactionId?: string,
    ) => ({
        providerId: 'provider-ooo',
        externalTransactionId,
        idempotencyKey: `provider-ooo:${externalTransactionId}`,
        playerId: w.playerId,
        walletId: w.walletId,
        roundId: 'round-ooo',
        gameId: 'game-ooo',
        kind,
        money: { amount, currency: 'BRL' },
        ...(referenceExternalTransactionId ? { referenceExternalTransactionId } : {}),
    });

    async function eventTypesFor(transactionId: string, walletId?: string): Promise<string[]> {
        const em = orms[0]!.em.fork();
        try {
            const ids = walletId ? [transactionId, walletId] : [transactionId];
            const events = await em.find(OutboxEventEntity, { aggregateId: { $in: ids } }, { orderBy: { occurredAt: 'ASC' } });
            return events.map((event) => event.eventType);
        } finally {
            em.clear();
        }
    }

    async function transaction(id: string) {
        const em = orms[0]!.em.fork();
        try {
            return await em.findOneOrFail(WagerTransactionEntity, { id });
        } finally {
            em.clear();
        }
    }

    it('REFUND antes da BET: fica PENDING_REFERENCE e é aplicado pelo worker quando a BET chega', async () => {
        const w = await newWallet('100.00');
        const betExt = `bet-${randomUUID()}`;

        const refund = await useCase().execute(
            command(w, WagerTransactionType.REFUND, `refund-${randomUUID()}`, '40.00', betExt),
        );
        expect(refund.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
        expect(await eventTypesFor(refund.transactionId)).toEqual(['WagerTransactionPendingReference']);
        // Nada mudou no saldo nem no ledger enquanto a referência não existe.
        expect((await expectLedgerMatchesBalance(orms[0]!, w.walletId)).balance).toBe('100.00');

        // Antes da BET chegar, o worker só reagenda (backoff), sem efeito financeiro.
        const early = await worker().processBatch(500, soon());
        expect(early.attempted).toBeGreaterThanOrEqual(1);
        expect((await transaction(refund.transactionId)).status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
        expect((await transaction(refund.transactionId)).referenceAttempts).toBe(1);

        const bet = await useCase().execute(command(w, WagerTransactionType.BET, betExt, '40.00'));
        expect(bet.status).toBe(WagerTransactionStatus.PROCESSED);
        expect(bet.balance?.amount).toBe('60.00');

        // Momento posterior ao novo agendamento (10 s) e ainda dentro do TTL.
        await worker().processBatch(500, new Date(Date.now() + 120_000));

        const applied = await transaction(refund.transactionId);
        expect(applied.status).toBe(WagerTransactionStatus.PROCESSED);
        expect(applied.referenceTransactionId).toBe(bet.transactionId);

        const { balance, entries } = await expectLedgerMatchesBalance(orms[0]!, w.walletId);
        expect(balance).toBe('100.00');
        expect(entries).toBe(3); // OPENING + BET (débito) + REFUND (crédito)
        expect(await eventTypesFor(refund.transactionId)).toEqual([
            'WagerTransactionPendingReference',
            'WagerTransactionProcessed',
        ]);
    });

    it('ROLLBACK antes da BET com DOIS workers concorrentes: aplicado exatamente uma vez', async () => {
        const w = await newWallet('100.00');
        const betExt = `bet-${randomUUID()}`;

        const rollback = await useCase().execute(
            command(w, WagerTransactionType.ROLLBACK, `rollback-${randomUUID()}`, '25.00', betExt),
        );
        expect(rollback.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);

        await useCase(1).execute(command(w, WagerTransactionType.BET, betExt, '25.00'));

        const at = soon();
        const [a, b] = await Promise.all([worker(0).processBatch(500, at), worker(1).processBatch(500, at)]);
        expect(a.processed + b.processed).toBeGreaterThanOrEqual(1);

        expect((await transaction(rollback.transactionId)).status).toBe(WagerTransactionStatus.PROCESSED);

        const em = orms[0]!.em.fork();
        try {
            // Um único lançamento para o ROLLBACK, ainda que dois workers tenham disputado a linha.
            expect(await em.count(LedgerEntryEntity, { transactionId: rollback.transactionId })).toBe(1);
        } finally {
            em.clear();
        }
        const { balance, entries } = await expectLedgerMatchesBalance(orms[0]!, w.walletId);
        expect(balance).toBe('100.00');
        expect(entries).toBe(3);
    });

    it('referência que nunca chega: REJECTED/REFERENCE_EXPIRED após o TTL, com evento publicado e sem ledger', async () => {
        const w = await newWallet('100.00');

        const refund = await useCase().execute(
            command(w, WagerTransactionType.REFUND, `refund-${randomUUID()}`, '10.00', `never-${randomUUID()}`),
        );
        expect(refund.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);

        // 25 h depois: o TTL de 24 h venceu.
        await worker().processBatch(500, new Date(Date.now() + 25 * 60 * 60 * 1_000));

        const expired = await transaction(refund.transactionId);
        expect(expired.status).toBe(WagerTransactionStatus.REJECTED);
        expect(expired.failureCode).toBe(WagerTransactionFailureCode.REFERENCE_EXPIRED);
        expect(await eventTypesFor(refund.transactionId)).toEqual([
            'WagerTransactionPendingReference',
            'WagerTransactionRejected',
        ]);

        const { balance, entries } = await expectLedgerMatchesBalance(orms[0]!, w.walletId);
        expect(balance).toBe('100.00');
        expect(entries).toBe(1); // só o OPENING
    });
});
