export interface WagerTransactionEventData {
    transactionId: string;
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    kind: string;
    amount: { amount: string; currency: string };
    status: string;
    failureCode?: string;
    referenceExternalTransactionId?: string;
}
