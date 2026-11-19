import { WagerTransaction } from '../../domain/transactions/wager-transaction.js';
import { WagerTransactionType } from '../../domain/transactions/wager-transaction-type.js';

export interface WagerTransactionRepository {
    findById(id: string): Promise<WagerTransaction | null>;

    findByIdForUpdate(id: string): Promise<WagerTransaction | null>;

    findByProviderAndExternalId(
        providerId: string,
        externalTransactionId: string,
    ): Promise<WagerTransaction | null>;

    findByProviderAndExternalIdForUpdate(
        providerId: string,
        externalTransactionId: string,
    ): Promise<WagerTransaction | null>;

    findByIdempotencyKey(
        providerId: string,
        idempotencyKey: string,
    ): Promise<WagerTransaction | null>;

    findByReferenceExternalId(
        providerId: string,
        externalTransactionId: string,
    ): Promise<WagerTransaction | null>;

    findByReferenceTransactionIdAndType(
        referenceTransactionId: string,
        type: WagerTransactionType,
    ): Promise<WagerTransaction | null>;

    findPendingReferences(
        now: Date,
        limit: number,
    ): Promise<WagerTransaction[]>;

    save(transaction: WagerTransaction): Promise<void>;
}
