import { Injectable, Inject } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import {
    TransactionRepositories,
    UnitOfWork,
} from '../../../application/ports/unit-of-work.js';

import { MikroOrmWalletRepository } from '../repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWagerTransactionRepository } from '../repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmLedgerRepository } from '../repositories/mikro-orm-ledger.repository.js';
import { MikroOrmOutboxEventRepository } from '../repositories/mikro-orm-outbox-event.repository.js';
import { MikroOrmInboxMessageRepository } from '../repositories/mikro-orm-inbox-message.repository.js';

@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
    constructor(
        @Inject(EntityManager)
        private readonly em: EntityManager,
    ) {}

    async execute<T>(
        operation: (repositories: TransactionRepositories) => Promise<T>,
    ): Promise<T> {
        return this.em.transactional(async (transactionalEm) => {
            const repositories: TransactionRepositories = {
                wallets: new MikroOrmWalletRepository(transactionalEm),
                transactions: new MikroOrmWagerTransactionRepository(transactionalEm),
                ledger: new MikroOrmLedgerRepository(transactionalEm),
                outbox: new MikroOrmOutboxEventRepository(transactionalEm),
                inbox: new MikroOrmInboxMessageRepository(transactionalEm),
            };

            return operation(repositories);
        });
    }
}
