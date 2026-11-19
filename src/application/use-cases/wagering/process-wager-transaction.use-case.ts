import { Inject, Injectable, Logger } from '@nestjs/common';
import { InboxMessage } from '../../../domain/messaging/inbox-message.js';
import { OutboxMessage } from '../../../domain/messaging/outbox-message.js';
import { randomUUID } from 'node:crypto';

import { Money } from '../../../domain/money/money.js';
import { Wallet } from '../../../domain/wallets/wallet.js';
import { LedgerEntry } from '../../../domain/ledger/ledger-entry.js';
import { LedgerEntryDirection } from '../../../domain/ledger/ledger-entry-direction.js';
import { WagerTransaction } from '../../../domain/transactions/wager-transaction.js';
import { WagerTransactionType } from '../../../domain/transactions/wager-transaction-type.js';
import { WagerTransactionStatus } from '../../../domain/transactions/wager-transaction-status.js';
import { WagerTransactionFailureCode } from '../../../domain/transactions/wager-transaction-failure-code.js';

import type {
    TransactionRepositories,
    UnitOfWork,
} from '../../ports/unit-of-work.js';
import { UNIT_OF_WORK } from '../../ports/tokens.js';
import type { ProcessWagerTransactionInput } from './dto/process-wager-transaction.input.js';

import { ReferenceRetryPolicy } from '../../../domain/transactions/reference-retry-policy.js';
import { WagerTransactionProcessed } from '../../events/wager-transaction-processed.event.js';
import { WagerTransactionRejected } from '../../events/wager-transaction-rejected.event.js';
import { WagerTransactionPendingReference } from '../../events/wager-transaction-pending-reference.event.js';
import { WalletBalanceChanged } from '../../events/wallet-balance-changed.event.js';
import type { IntegrationEvent } from '../../events/integration-event.js';
import {
    ApplicationValidationError,
    ExternalTransactionConflictError,
    IdempotencyConflictError,
    InboxPayloadMismatchError,
    WalletNotFoundError,
    WalletOwnershipMismatchError,
} from '../../errors/application-errors.js';
import { canonicalStringify, sha256Hex } from '../../validation/canonical-json.js';
import { metrics, recordLockConflict } from '../../../infrastructure/observability/metrics.js';
import { bindLogContext } from '../../../infrastructure/observability/request-context.js';

// Compatibilidade: estes erros já eram exportados daqui.
export {
    ExternalTransactionConflictError,
    IdempotencyConflictError,
    WalletNotFoundError,
    WalletOwnershipMismatchError,
};

export interface InboxExecutionContext {
    consumerName: string;
    messageId: string;
    messageGroupId?: string;
    /** sha256 do JSON canônico dos campos de negócio da mensagem. */
    payloadHash: string;
    payload: Record<string, unknown>;
}

export interface ProcessWagerTransactionOutput {
    transactionId: string;
    status: WagerTransactionStatus;
    balance: {
        amount: string;
        currency: string;
    } | null;
    failureCode?: WagerTransactionFailureCode;
    idempotentReplay: boolean;
}

@Injectable()
export class ProcessWagerTransactionUseCase {
    private readonly logger = new Logger(ProcessWagerTransactionUseCase.name);

    constructor(
        @Inject(UNIT_OF_WORK)
        private readonly unitOfWork: UnitOfWork,

        private readonly referenceRetryPolicy: ReferenceRetryPolicy = new ReferenceRetryPolicy(),
    ) {}

    /**
     * Ponto de entrada único para HTTP e SQS (mesmo caso de uso, conforme o
     * enunciado). Mede latência, conta resultados e propaga o contexto de log.
     */
    async execute(
        input: ProcessWagerTransactionInput,
        inboxContext?: InboxExecutionContext,
    ): Promise<ProcessWagerTransactionOutput> {
        const startedAt = performance.now();
        const source = inboxContext ? 'sqs' : 'http';
        bindLogContext({
            providerId: input.providerId,
            walletId: input.walletId,
            ...(inboxContext ? { messageId: inboxContext.messageId } : {}),
        });

        try {
            const output = await this.executeInternal(input, inboxContext);
            bindLogContext({ transactionId: output.transactionId });

            if (output.idempotentReplay) {
                metrics.duplicatesTotal.inc({ source });
            } else {
                metrics.transactionsTotal.inc({
                    status: output.status,
                    kind: input.kind,
                    source,
                });
            }
            metrics.processingDurationSeconds.observe(
                (performance.now() - startedAt) / 1000,
                { source, status: output.status },
            );
            this.logger.log(
                JSON.stringify({
                    event: output.idempotentReplay
                        ? 'wager_transaction_replayed'
                        : 'wager_transaction_processed',
                    status: output.status,
                    kind: input.kind,
                    failureCode: output.failureCode,
                    source,
                }),
            );
            return output;
        } catch (error) {
            if (
                error instanceof IdempotencyConflictError ||
                error instanceof ExternalTransactionConflictError
            ) {
                metrics.idempotencyConflictsTotal.inc({ source });
            } else {
                recordLockConflict(error);
            }
            throw error;
        }
    }

    private async executeInternal(
        input: ProcessWagerTransactionInput,
        inboxContext?: InboxExecutionContext,
    ): Promise<ProcessWagerTransactionOutput> {
        const requiresReference =
            input.kind === WagerTransactionType.REFUND ||
            input.kind === WagerTransactionType.ROLLBACK;

        if (
            requiresReference &&
            !input.referenceExternalTransactionId?.trim()
        ) {
            throw new ApplicationValidationError(
                `${input.kind} requires a reference external transaction ID.`,
            );
        }

        this.validateSupportedType(input.kind);

        const amount = Money.create(input.money.amount, input.money.currency);

        if (!amount.isPositive()) {
            throw new ApplicationValidationError(
                'Transaction amount must be greater than zero.',
            );
        }

        const requestHash = this.createRequestHash(input, amount);

        try {
            return await this.unitOfWork.execute(async (repositories) => {
                if (inboxContext) {
                    if (!repositories.inbox) {
                        throw new Error('Inbox repository is not configured in the UnitOfWork.');
                    }

                    const registration = await repositories.inbox.registerReceived(this.receiveInbox(inboxContext));

                    if (registration === 'PAYLOAD_MISMATCH') {
                        throw new InboxPayloadMismatchError(inboxContext.messageId);
                    }

                    if (registration === 'DUPLICATE') {
                        const processed =
                            await repositories.transactions.findByIdempotencyKey(
                                input.providerId,
                                input.idempotencyKey,
                            );
                        if (!processed) {
                            throw new Error(
                                'Processed Inbox message has no matching wager transaction.',
                            );
                        }
                        return this.replayOrConflict(processed, requestHash);
                    }

                    await repositories.inbox.markProcessing(
                        inboxContext.consumerName,
                        inboxContext.messageId,
                    );
                }

                const result = await (async () => {
                const existing =
                    await repositories.transactions.findByIdempotencyKey(
                        input.providerId,
                        input.idempotencyKey,
                    );

                if (existing) {
                    return this.replayOrConflict(existing, requestHash);
                }

                const externalTransaction =
                    await repositories.transactions.findByProviderAndExternalId(
                        input.providerId,
                        input.externalTransactionId,
                    );

                if (externalTransaction) {
                    // Concurrent requests carrying the same idempotency key
                    // and external transaction ID can race: one commits while
                    // the other is still performing the initial lookups. Treat
                    // that exact same request as a replay, not as an external
                    // transaction collision.
                    if (externalTransaction.idempotencyKey === input.idempotencyKey) {
                        return this.replayOrConflict(externalTransaction, requestHash);
                    }
                    throw new ExternalTransactionConflictError();
                }

                const now = new Date();

                let reversalReference: WagerTransaction | null = null;

                if (requiresReference) {
                    const reference =
                        await repositories.transactions.findByProviderAndExternalIdForUpdate(
                            input.providerId,
                            input.referenceExternalTransactionId!,
                        );

                    if (!reference) {
                        const pendingTransaction = WagerTransaction.create({
                            id: randomUUID(),
                            providerId: input.providerId,
                            providerTransactionId: input.externalTransactionId,
                            playerId: input.playerId,
                            walletId: input.walletId,
                            roundId: input.roundId,
                            gameId: input.gameId,
                            type: input.kind,
                            amount,
                            referenceExternalTransactionId:
                                input.referenceExternalTransactionId,
                            idempotencyKey: input.idempotencyKey,
                            requestHash,
                        });

                        pendingTransaction.markPendingReference();

                        const nextAttemptAt =
                            this.referenceRetryPolicy.getNextAttemptAt(0, now);

                        const expiresAt =
                            this.referenceRetryPolicy.getExpirationAt(now);

                        pendingTransaction.initializeReferenceRetrySchedule(
                            nextAttemptAt,
                            expiresAt,
                        );

                        await repositories.transactions.save(
                            pendingTransaction,
                        );
                        await this.enqueueEvent(
                            repositories,
                            new WagerTransactionPendingReference({
                                eventId: randomUUID(),
                                aggregateId: pendingTransaction.id,
                                correlationId: pendingTransaction.id,
                                occurredAt: now,
                                data: this.toWagerEventData(pendingTransaction),
                            }),
                        );

                        return this.toOutput(pendingTransaction, false);
                    }

                    let referenceFailureCode:
                        WagerTransactionFailureCode | undefined;

                    let referenceFailureReason: string | undefined;

                    const validReferenceTypes =
                        input.kind === WagerTransactionType.REFUND
                            ? [WagerTransactionType.BET]
                            : [
                                  WagerTransactionType.BET,
                                  WagerTransactionType.WIN,
                                  WagerTransactionType.REFUND,
                              ];

                    if (!validReferenceTypes.includes(reference.type)) {
                        referenceFailureCode =
                            WagerTransactionFailureCode.REFERENCE_MISMATCH;
                        referenceFailureReason = `${input.kind} cannot reference transaction type ${reference.type}.`;
                    } else if (
                        reference.status !== WagerTransactionStatus.PROCESSED
                    ) {
                        referenceFailureCode =
                            WagerTransactionFailureCode.REFERENCE_NOT_PROCESSED;
                        referenceFailureReason =
                            'The referenced transaction has not been processed.';
                    } else if (
                        reference.providerId !== input.providerId ||
                        reference.playerId !== input.playerId ||
                        reference.walletId !== input.walletId ||
                        reference.roundId !== input.roundId ||
                        reference.amount.currency !== amount.currency ||
                        reference.amount.toString() !== amount.toString()
                    ) {
                        referenceFailureCode =
                            WagerTransactionFailureCode.REFERENCE_MISMATCH;
                        referenceFailureReason =
                            'The reversal does not match the referenced transaction.';
                    }

                    if (referenceFailureCode) {
                        const rejectedTransaction = WagerTransaction.create({
                            id: randomUUID(),
                            providerId: input.providerId,
                            providerTransactionId: input.externalTransactionId,
                            playerId: input.playerId,
                            walletId: input.walletId,
                            roundId: input.roundId,
                            gameId: input.gameId,
                            type: input.kind,
                            amount,
                            referenceExternalTransactionId:
                                input.referenceExternalTransactionId,
                            idempotencyKey: input.idempotencyKey,
                            requestHash,
                        });

                        rejectedTransaction.reject(
                            referenceFailureReason!,
                            referenceFailureCode,
                            now,
                        );

                        await repositories.transactions.save(
                            rejectedTransaction,
                        );
                        await this.enqueueRejectedEvent(repositories, rejectedTransaction, now);

                        return this.toOutput(rejectedTransaction, false);
                    }

                    const existingRefund =
                        await repositories.transactions.findByReferenceTransactionIdAndType(
                            reference.id,
                            WagerTransactionType.REFUND,
                        );

                    const existingRollback =
                        await repositories.transactions.findByReferenceTransactionIdAndType(
                            reference.id,
                            WagerTransactionType.ROLLBACK,
                        );

                    if (existingRefund || existingRollback) {
                        const rejectedTransaction = WagerTransaction.create({
                            id: randomUUID(),
                            providerId: input.providerId,
                            providerTransactionId: input.externalTransactionId,
                            playerId: input.playerId,
                            walletId: input.walletId,
                            roundId: input.roundId,
                            gameId: input.gameId,
                            type: input.kind,
                            amount,
                            referenceExternalTransactionId:
                                input.referenceExternalTransactionId,
                            idempotencyKey: input.idempotencyKey,
                            requestHash,
                        });

                        rejectedTransaction.reject(
                            'The referenced transaction has already been reversed.',
                            WagerTransactionFailureCode.REFERENCE_ALREADY_REVERSED,
                            now,
                        );

                        await repositories.transactions.save(
                            rejectedTransaction,
                        );
                        await this.enqueueRejectedEvent(repositories, rejectedTransaction, now);

                        return this.toOutput(rejectedTransaction, false);
                    }

                    reversalReference = reference;
                }

                const wallet = await this.lockWallet(repositories, input.walletId);

                if (!wallet) {
                    throw new WalletNotFoundError(input.walletId);
                }

                this.validateWallet(wallet, input);

                const transaction = WagerTransaction.create({
                    id: randomUUID(),
                    providerId: input.providerId,
                    providerTransactionId: input.externalTransactionId,
                    playerId: input.playerId,
                    walletId: input.walletId,
                    roundId: input.roundId,
                    gameId: input.gameId,
                    type: input.kind,
                    amount,
                    referenceTransactionId: reversalReference?.id,
                    referenceExternalTransactionId:
                        input.referenceExternalTransactionId,
                    idempotencyKey: input.idempotencyKey,
                    requestHash,
                });

                // Timestamp tomado DEPOIS do lock: aproxima createdAt da ordem real de
                // aplicação (a ordem canônica, porém, é walletVersion).
                return this.applyWalletMovement(
                    repositories,
                    transaction,
                    reversalReference ?? undefined,
                    wallet,
                    new Date(),
                );
                })();

                if (inboxContext) {
                    await repositories.inbox!.markProcessed(
                        inboxContext.consumerName,
                        inboxContext.messageId,
                        new Date(),
                    );
                }

                return result;
            });
        } catch (error) {
            if (!this.isPostgresUniqueViolation(error)) {
                throw error;
            }

            // Corrida resolvida pelo índice único: outra instância gravou antes.
            metrics.lockConflictsTotal.inc({ kind: 'unique_violation_race' });
            const recovered = await this.recoverUniqueConflict(input, requestHash, error);
            if (inboxContext) {
                await this.unitOfWork.execute(async (repositories) => {
                    const registration = await repositories.inbox!.registerReceived(this.receiveInbox(inboxContext));
                    if (registration === 'PAYLOAD_MISMATCH') {
                        throw new InboxPayloadMismatchError(inboxContext.messageId);
                    }
                    if (registration !== 'DUPLICATE') {
                        await repositories.inbox!.markProcessing(
                            inboxContext.consumerName,
                            inboxContext.messageId,
                        );
                        await repositories.inbox!.markProcessed(
                            inboxContext.consumerName,
                            inboxContext.messageId,
                            new Date(),
                        );
                    }
                });
            }
            return recovered;
        }
    }

    /**
     * Processes a previously persisted PENDING_REFERENCE transaction.
     * The caller must invoke this method inside the same UnitOfWork transaction
     * that selected/locked the pending row with SKIP LOCKED.
     */
    async processPendingReference(
        repositories: TransactionRepositories,
        transaction: WagerTransaction,
        at: Date = new Date(),
    ): Promise<ProcessWagerTransactionOutput> {
        if (transaction.status !== WagerTransactionStatus.PENDING_REFERENCE) {
            return this.toOutput(transaction, true);
        }

        const expiresAt = transaction.referenceExpiresAt;

        if (!expiresAt) {
            throw new Error(
                `Pending reference transaction ${transaction.id} has no expiration date.`,
            );
        }

        if (at.getTime() >= expiresAt.getTime()) {
            transaction.reject(
                'The referenced transaction was not found before the retry window expired.',
                WagerTransactionFailureCode.REFERENCE_EXPIRED,
                at,
            );
            await repositories.transactions.save(transaction);
            await this.enqueueRejectedEvent(repositories, transaction, at);
            return this.toOutput(transaction, false);
        }

        const nextAttemptAt = this.getNextRetryAt(
            transaction.referenceAttempts,
            at,
            expiresAt,
        );
        transaction.recordReferenceAttempt(nextAttemptAt);

        const reference =
            await repositories.transactions.findByProviderAndExternalIdForUpdate(
                transaction.providerId,
                transaction.referenceExternalTransactionId!,
            );

        if (!reference) {
            await repositories.transactions.save(transaction);
            return this.toOutput(transaction, false);
        }

        const validReferenceTypes =
            transaction.type === WagerTransactionType.REFUND
                ? [WagerTransactionType.BET]
                : [
                      WagerTransactionType.BET,
                      WagerTransactionType.WIN,
                      WagerTransactionType.REFUND,
                  ];

        let rejectionCode: WagerTransactionFailureCode | undefined;
        let rejectionReason: string | undefined;

        if (!validReferenceTypes.includes(reference.type)) {
            rejectionCode = WagerTransactionFailureCode.REFERENCE_MISMATCH;
            rejectionReason = `${transaction.type} cannot reference transaction type ${reference.type}.`;
        } else if (reference.status !== WagerTransactionStatus.PROCESSED) {
            rejectionCode = WagerTransactionFailureCode.REFERENCE_NOT_PROCESSED;
            rejectionReason =
                'The referenced transaction has not been processed.';
        } else if (
            reference.providerId !== transaction.providerId ||
            reference.playerId !== transaction.playerId ||
            reference.walletId !== transaction.walletId ||
            reference.roundId !== transaction.roundId ||
            reference.amount.currency !== transaction.amount.currency ||
            reference.amount.toString() !== transaction.amount.toString()
        ) {
            rejectionCode = WagerTransactionFailureCode.REFERENCE_MISMATCH;
            rejectionReason =
                'The reversal does not match the referenced transaction.';
        }

        if (rejectionCode) {
            transaction.reject(rejectionReason!, rejectionCode, at);
            await repositories.transactions.save(transaction);
            await this.enqueueRejectedEvent(repositories, transaction, at);
            return this.toOutput(transaction, false);
        }

        const existingRefund =
            await repositories.transactions.findByReferenceTransactionIdAndType(
                reference.id,
                WagerTransactionType.REFUND,
            );
        const existingRollback =
            await repositories.transactions.findByReferenceTransactionIdAndType(
                reference.id,
                WagerTransactionType.ROLLBACK,
            );

        if (existingRefund || existingRollback) {
            transaction.reject(
                'The referenced transaction has already been reversed.',
                WagerTransactionFailureCode.REFERENCE_ALREADY_REVERSED,
                at,
            );
            await repositories.transactions.save(transaction);
            await this.enqueueRejectedEvent(repositories, transaction, at);
            return this.toOutput(transaction, false);
        }

        transaction.attachReferenceTransaction(reference.id);

        const wallet = await this.lockWallet(repositories, transaction.walletId);

        if (!wallet) {
            transaction.reject(
                'The wallet associated with the pending transaction no longer exists.',
                WagerTransactionFailureCode.INVALID_TRANSACTION,
                at,
            );
            await repositories.transactions.save(transaction);
            await this.enqueueRejectedEvent(repositories, transaction, at);
            return this.toOutput(transaction, false);
        }

        if (
            wallet.playerId !== transaction.playerId ||
            wallet.currency !== transaction.amount.currency
        ) {
            transaction.reject(
                'The wallet does not belong to the pending transaction player or currency.',
                WagerTransactionFailureCode.INVALID_TRANSACTION,
                at,
            );
            await repositories.transactions.save(transaction);
            await this.enqueueRejectedEvent(repositories, transaction, at);
            return this.toOutput(transaction, false);
        }

        return this.applyWalletMovement(
            repositories,
            transaction,
            reference,
            wallet,
            at,
        );
    }

    /**
     * Shared financial mutation path for synchronous requests and reference retries.
     * Wallet balance and ledger entries are always updated together in the caller's
     * UnitOfWork transaction.
     */
    private async applyWalletMovement(
        repositories: TransactionRepositories,
        transaction: WagerTransaction,
        reference: WagerTransaction | undefined,
        wallet: Wallet,
        at: Date,
    ): Promise<ProcessWagerTransactionOutput> {
        const balanceBefore = wallet.balance;
        const direction = transaction.ledgerDirectionFor(reference);

        if (
            direction === LedgerEntryDirection.DEBIT &&
            balanceBefore.isLessThan(transaction.amount)
        ) {
            transaction.setResponseBalance(balanceBefore);
            transaction.reject(
                'Insufficient wallet balance.',
                transaction.type === WagerTransactionType.ROLLBACK
                    ? WagerTransactionFailureCode.ROLLBACK_INSUFFICIENT_FUNDS
                    : WagerTransactionFailureCode.INSUFFICIENT_FUNDS,
                at,
            );
            await repositories.transactions.save(transaction);
            await this.enqueueRejectedEvent(repositories, transaction, at);
            return this.toOutput(transaction, false);
        }

        if (direction === LedgerEntryDirection.DEBIT) {
            wallet.debit(transaction.amount);
        } else if (direction === LedgerEntryDirection.CREDIT) {
            wallet.credit(transaction.amount);
        }

        const balanceAfter = wallet.balance;
        transaction.setResponseBalance(balanceAfter);
        transaction.markProcessed(at);

        if (direction !== undefined) {
            const entry = LedgerEntry.create({
                id: randomUUID(),
                walletId: wallet.id,
                transactionId: transaction.id,
                transactionType: transaction.type,
                direction,
                amount: transaction.amount,
                balanceBefore,
                balanceAfter,
                createdAt: at.toISOString(),
                walletVersion: wallet.version,
            });

            await repositories.wallets.save(wallet);
            await repositories.ledger.save(entry);
        }

        await repositories.transactions.save(transaction);

        // Integration events are persisted in the same PostgreSQL transaction
        // as the wallet, ledger and wager transaction. Publishing happens later.
        await this.enqueueEvent(
            repositories,
            new WagerTransactionProcessed({
                eventId: randomUUID(),
                aggregateId: transaction.id,
                correlationId: transaction.id,
                occurredAt: at,
                data: this.toWagerEventData(transaction),
            }),
        );

        if (direction !== undefined) {
            await this.enqueueEvent(
                repositories,
                new WalletBalanceChanged({
                    eventId: randomUUID(),
                    aggregateId: wallet.id,
                    correlationId: transaction.id,
                    occurredAt: at,
                    data: {
                        walletId: wallet.id,
                        transactionId: transaction.id,
                        direction,
                        money: {
                            amount: transaction.amount.toString(),
                            currency: transaction.amount.currency,
                        },
                        balanceBefore: {
                            amount: balanceBefore.toString(),
                            currency: balanceBefore.currency,
                        },
                        balanceAfter: {
                            amount: balanceAfter.toString(),
                            currency: balanceAfter.currency,
                        },
                        walletVersion: wallet.version,
                    },
                }),
                'Wallet',
            );
        }

        return this.toOutput(transaction, false);
    }

    private toWagerEventData(transaction: WagerTransaction) {
        return {
            transactionId: transaction.id,
            providerId: transaction.providerId,
            externalTransactionId: transaction.providerTransactionId,
            playerId: transaction.playerId,
            walletId: transaction.walletId,
            kind: transaction.type,
            amount: {
                amount: transaction.amount.toString(),
                currency: transaction.amount.currency,
            },
            status: transaction.status,
            ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
            ...(transaction.referenceExternalTransactionId
                ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId }
                : {}),
        };
    }

    private async enqueueRejectedEvent(
        repositories: TransactionRepositories,
        transaction: WagerTransaction,
        at: Date,
    ): Promise<void> {
        await this.enqueueEvent(
            repositories,
            new WagerTransactionRejected({
                eventId: randomUUID(),
                aggregateId: transaction.id,
                correlationId: transaction.id,
                occurredAt: at,
                data: this.toWagerEventData(transaction),
            }),
        );
    }

    private async enqueueEvent(
        repositories: TransactionRepositories,
        event: IntegrationEvent<unknown>,
        aggregateType = 'WagerTransaction',
    ): Promise<void> {
        await repositories.outbox?.enqueue(
            OutboxMessage.enqueue(event, aggregateType),
        );
    }

    private receiveInbox(inboxContext: InboxExecutionContext): InboxMessage {
        return InboxMessage.receive({
            id: randomUUID(),
            consumerName: inboxContext.consumerName,
            messageId: inboxContext.messageId,
            messageGroupId: inboxContext.messageGroupId,
            payloadHash: inboxContext.payloadHash,
            payload: inboxContext.payload,
            receivedAt: new Date(),
        });
    }

    /** Lock pessimista da wallet, medindo quanto tempo a transação esperou na fila do lock. */
    private async lockWallet(
        repositories: TransactionRepositories,
        walletId: string,
    ): Promise<Wallet | null> {
        const startedAt = performance.now();
        try {
            return await repositories.wallets.findByIdForUpdate(walletId);
        } finally {
            metrics.walletLockWaitSeconds.observe(
                (performance.now() - startedAt) / 1000,
            );
        }
    }

    private getNextRetryAt(
        completedAttempts: number,
        at: Date,
        expiresAt: Date,
    ): Date {
        const scheduled = this.referenceRetryPolicy.getNextAttemptAt(
            completedAttempts + 1,
            at,
        );

        return new Date(Math.min(scheduled.getTime(), expiresAt.getTime()));
    }

    private async recoverUniqueConflict(
        input: ProcessWagerTransactionInput,
        requestHash: string,
        originalError: unknown,
    ): Promise<ProcessWagerTransactionOutput> {
        return this.unitOfWork.execute(async (repositories) => {
            const existing =
                await repositories.transactions.findByIdempotencyKey(
                    input.providerId,
                    input.idempotencyKey,
                );

            if (existing) {
                return this.replayOrConflict(existing, requestHash);
            }

            const externalTransaction =
                await repositories.transactions.findByProviderAndExternalId(
                    input.providerId,
                    input.externalTransactionId,
                );

            if (externalTransaction) {
                throw new ExternalTransactionConflictError();
            }

            throw originalError;
        });
    }

    private replayOrConflict(
        transaction: WagerTransaction,
        requestHash: string,
    ): ProcessWagerTransactionOutput {
        if (!transaction.matchesPayload(requestHash)) {
            throw new IdempotencyConflictError();
        }

        return this.toOutput(transaction, true);
    }

    private toOutput(
        transaction: WagerTransaction,
        idempotentReplay: boolean,
    ): ProcessWagerTransactionOutput {
        const balance = transaction.responseBalance;

        return {
            transactionId: transaction.id,
            status: transaction.status,
            balance: balance
                ? {
                      amount: balance.toString(),
                      currency: balance.currency,
                  }
                : null,
            failureCode: transaction.failureCode,
            idempotentReplay,
        };
    }

    private validateWallet(
        wallet: Wallet,
        input: ProcessWagerTransactionInput,
    ): void {
        if (
            wallet.playerId !== input.playerId ||
            wallet.currency !== input.money.currency
        ) {
            throw new WalletOwnershipMismatchError();
        }
    }

    private validateSupportedType(type: WagerTransactionType): void {
        const supportedTypes = [
            WagerTransactionType.BET,
            WagerTransactionType.WIN,
            WagerTransactionType.LOSS,
            WagerTransactionType.REFUND,
            WagerTransactionType.ROLLBACK,
        ];

        if (!supportedTypes.includes(type)) {
            throw new ApplicationValidationError(
                `Transaction type ${type} is not supported by this processing stage.`,
            );
        }
    }

    /**
     * payloadHash = sha256( JSON canônico (chaves ordenadas) dos campos de negócio ).
     * O header Idempotency-Key e qualquer metadado de transporte ficam de fora.
     * O valor monetário entra normalizado (escala 2), então "25" e "25.00"
     * representam o mesmo payload.
     */
    private createRequestHash(
        input: ProcessWagerTransactionInput,
        amount: Money,
    ): string {
        return sha256Hex(
            canonicalStringify({
                providerId: input.providerId,
                externalTransactionId: input.externalTransactionId,
                playerId: input.playerId,
                walletId: input.walletId,
                roundId: input.roundId,
                gameId: input.gameId,
                kind: input.kind,
                referenceExternalTransactionId:
                    input.referenceExternalTransactionId ?? null,
                money: { amount: amount.toString(), currency: amount.currency },
            }),
        );
    }

    private isPostgresUniqueViolation(error: unknown): boolean {
        let current: unknown = error;

        for (let depth = 0; depth < 5; depth++) {
            if (typeof current !== 'object' || current === null) {
                return false;
            }

            const candidate = current as {
                code?: unknown;
                cause?: unknown;
                driverException?: unknown;
                original?: unknown;
            };

            if (candidate.code === '23505') {
                return true;
            }

            current =
                candidate.cause ??
                candidate.driverException ??
                candidate.original;
        }

        return false;
    }
}
