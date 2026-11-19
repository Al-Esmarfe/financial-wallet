import { EntityManager } from '@mikro-orm/postgresql';

import { FilterQuery, QueryOrder } from '@mikro-orm/core';

import { LedgerRepository } from '../../../application/ports/ledger.repository.js';
import { LedgerEntry } from '../../../domain/ledger/ledger-entry.js';
import { LedgerEntryDirection } from '../../../domain/ledger/ledger-entry-direction.js';
import { Money } from '../../../domain/money/money.js';
import { WagerTransactionType } from '../../../domain/transactions/wager-transaction-type.js';
import { LedgerEntryEntity } from '../entities/ledger-entry.entity.js';

export class MikroOrmLedgerRepository implements LedgerRepository {
    constructor(private readonly em: EntityManager) {}

    async findById(id: string): Promise<LedgerEntry | null> {
        const entity = await this.em.findOne(LedgerEntryEntity, { id });

        return entity ? this.toDomain(entity) : null;
    }

    async findByTransactionId(
        transactionId: string,
    ): Promise<LedgerEntry | null> {
        const entity = await this.em.findOne(LedgerEntryEntity, {
            transactionId,
        });

        return entity ? this.toDomain(entity) : null;
    }

    async findByWalletId(
        walletId: string,
        limit: number,
        cursor?: string,
    ): Promise<LedgerEntry[]> {
        if (!Number.isInteger(limit) || limit <= 0) {
            throw new Error('Limit must be a positive integer.');
        }

        let cursorEntry: LedgerEntryEntity | null = null;

        if (cursor) {
            cursorEntry = await this.em.findOne(LedgerEntryEntity, {
                id: cursor,
                walletId,
            });

            if (!cursorEntry) {
                throw new Error('Ledger cursor was not found for this wallet.');
            }
        }

        const where: FilterQuery<LedgerEntryEntity> = cursorEntry
            ? { walletId, walletVersion: { $lt: cursorEntry.walletVersion } }
            : { walletId };

        const entities = await this.em.find(LedgerEntryEntity, where, {
            // Ordem canônica = sequência da wallet (única por wallet): paginação estável.
            orderBy: { walletVersion: QueryOrder.DESC },
            limit,
        });

        return entities.map((entity) => this.toDomain(entity));
    }

    async save(entry: LedgerEntry): Promise<void> {
        const entity = this.em.create(LedgerEntryEntity, {
            id: entry.id,
            walletId: entry.walletId,
            transactionId: entry.transactionId,
            direction: entry.direction,
            transactionType: entry.transactionType,
            amount: entry.amount.toString(),
            currency: entry.amount.currency,
            balanceBefore: entry.balanceBefore.toString(),
            balanceAfter: entry.balanceAfter.toString(),
            walletVersion: entry.walletVersion,
            createdAt: new Date(entry.createdAt),
        });

        await this.em.persist(entity);
    }

    async countByWalletId(walletId: string): Promise<number> {
        return this.em.count(LedgerEntryEntity, { walletId });
    }

    private toDomain(entity: LedgerEntryEntity): LedgerEntry {
        const amount = Money.create(entity.amount, entity.currency);
        const balanceAfter = Money.create(entity.balanceAfter, entity.currency);
        const balanceBefore = Money.create(
            entity.balanceBefore,
            entity.currency,
        );

        return LedgerEntry.rehydrate({
            id: entity.id,
            walletId: entity.walletId,
            transactionId: entity.transactionId,
            transactionType: entity.transactionType as WagerTransactionType,
            direction: entity.direction as LedgerEntryDirection,
            amount,
            balanceBefore,
            balanceAfter,
            createdAt: entity.createdAt.toISOString(),
            walletVersion: entity.walletVersion,
        });
    }
}
