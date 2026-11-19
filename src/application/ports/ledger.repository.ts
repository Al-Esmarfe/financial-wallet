import { LedgerEntry } from '../../domain/ledger/ledger-entry.js';

export interface LedgerRepository {
    findById(id: string): Promise<LedgerEntry | null>;

    findByTransactionId(transactionId: string): Promise<LedgerEntry | null>;

    findByWalletId(
        walletId: string,
        limit: number,
        cursor?: string,
    ): Promise<LedgerEntry[]>;

    save(entry: LedgerEntry): Promise<void>;

    countByWalletId(walletId: string): Promise<number>;
}
