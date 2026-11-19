import { WagerTransactionType } from '../../../../domain/transactions/wager-transaction-type.js';

export interface ProcessWagerTransactionInput {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionType;
    referenceExternalTransactionId?: string;
    money: {
        amount: string;
        currency: string;
    };
}
