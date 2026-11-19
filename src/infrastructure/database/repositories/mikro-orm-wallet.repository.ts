import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';

import { WalletRepository } from '../../../application/ports/wallet.repository.js';
import { Wallet } from '../../../domain/wallets/wallet.js';
import { Money } from '../../../domain/money/money.js';
import { WalletEntity } from '../entities/wallet.entity.js';

export class MikroOrmWalletRepository implements WalletRepository {
    constructor(private readonly em: EntityManager) {}

    async findById(id: string): Promise<Wallet | null> {
        const entity = await this.em.findOne(WalletEntity, { id });

        return entity ? this.toDomain(entity) : null;
    }

    async findByPlayerAndCurrency(
        playerId: string,
        currency: string,
    ): Promise<Wallet | null> {
        const entity = await this.em.findOne(WalletEntity, {
            playerId,
            currency,
        });

        return entity ? this.toDomain(entity) : null;
    }

    async findByIdForUpdate(id: string): Promise<Wallet | null> {
        const entity = await this.em.findOne(
            WalletEntity,
            { id },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        return entity ? this.toDomain(entity) : null;
    }

    async existsByPlayerAndCurrency(
        playerId: string,
        currency: string,
    ): Promise<boolean> {
        const count = await this.em.count(WalletEntity, {
            playerId,
            currency,
        });

        return count > 0;
    }

    async save(wallet: Wallet): Promise<void> {
        const entity = await this.em.findOne(WalletEntity, {
            id: wallet.id,
        });

        if (!entity) {
            const created = this.em.create(WalletEntity, {
                id: wallet.id,
                playerId: wallet.playerId,
                currency: wallet.currency,
                balance: wallet.balance.toString(),
                version: wallet.version,
                createdAt: wallet.createdAt,
                updatedAt: wallet.updatedAt,
            });

            await this.em.persist(created);
            await this.em.flush();
            return;
        }

        const updatedAt = wallet.updatedAt;
        const balance = wallet.balance.toString();

        const affectedRows = await this.em.nativeUpdate(
            WalletEntity,
            { id: wallet.id },
            {
                balance,
                version: wallet.version,
                updatedAt,
            },
        );

        if (affectedRows !== 1) {
            throw new Error(
                `Failed to update wallet ${wallet.id}: expected 1 affected row, got ${affectedRows}.`,
            );
        }

        entity.balance = balance;
        entity.version = wallet.version;
        entity.updatedAt = updatedAt;
    }

    private toDomain(entity: WalletEntity): Wallet {
        const balance = Money.create(entity.balance, entity.currency);

        return Wallet.rehydrate({
            id: entity.id,
            playerId: entity.playerId,
            currency: entity.currency,
            balance,
            version: entity.version,
            createdAt: entity.createdAt,
            updatedAt: entity.updatedAt,
        });
    }
}
