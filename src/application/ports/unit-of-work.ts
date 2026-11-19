import { WalletRepository } from './wallet.repository.js';
import { WagerTransactionRepository } from './wager-transaction.repository.js';
import { LedgerRepository } from './ledger.repository.js';
import { OutboxEventRepository } from './outbox-event.repository.js';
import { InboxMessageRepository } from './inbox-message.repository.js';

export interface TransactionRepositories {
    wallets: WalletRepository;
    transactions: WagerTransactionRepository;
    ledger: LedgerRepository;
    outbox?: OutboxEventRepository;
    inbox?: InboxMessageRepository;
}

export interface UnitOfWork {
    execute<T>(
        operation: (repositories: TransactionRepositories) => Promise<T>,
    ): Promise<T>;
}
