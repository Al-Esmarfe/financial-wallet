import {
    Inject,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';

import type { UnitOfWork } from '../ports/unit-of-work.js';
import { UNIT_OF_WORK } from '../ports/tokens.js';
import { ReferenceRetryPolicy } from '../../domain/transactions/reference-retry-policy.js';
import { WagerTransactionStatus } from '../../domain/transactions/wager-transaction-status.js';
import { ProcessWagerTransactionUseCase } from '../use-cases/wagering/process-wager-transaction.use-case.js';
import { metrics } from '../../infrastructure/observability/metrics.js';

export interface ReferenceRetryBatchResult {
    attempted: number;
    processed: number;
    rejected: number;
    deferred: number;
    transientErrors: number;
}

@Injectable()
export class ReferenceRetryWorker implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ReferenceRetryWorker.name);
    private readonly intervalMs = this.readPositiveInteger(
        process.env.REFERENCE_RETRY_INTERVAL_MS,
        5_000,
        'REFERENCE_RETRY_INTERVAL_MS',
    );
    private readonly batchSize = this.readPositiveInteger(
        process.env.REFERENCE_RETRY_BATCH_SIZE,
        50,
        'REFERENCE_RETRY_BATCH_SIZE',
    );
    private timer?: ReturnType<typeof setInterval>;
    private running = false;

    constructor(
        @Inject(UNIT_OF_WORK)
        private readonly unitOfWork: UnitOfWork,
        private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
        private readonly retryPolicy: ReferenceRetryPolicy,
    ) {}

    onModuleInit(): void {
        this.timer = setInterval(() => {
            void this.runScheduledBatch();
        }, this.intervalMs);

        // Recover due rows after application restart without waiting a full interval.
        void this.runScheduledBatch();
    }

    async onModuleDestroy(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }

        // Shutdown cooperativo: deixa a transação em andamento concluir.
        while (this.running) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    async processBatch(
        limit = this.batchSize,
        at = new Date(),
    ): Promise<ReferenceRetryBatchResult> {
        if (!Number.isSafeInteger(limit) || limit <= 0) {
            throw new Error('Reference retry batch size must be positive.');
        }

        if (Number.isNaN(at.getTime())) {
            throw new Error('Reference retry batch date is invalid.');
        }

        if (this.running) {
            return this.emptyResult();
        }

        this.running = true;
        const result = this.emptyResult();

        try {
            while (result.attempted < limit) {
                let selectedId: string | undefined;

                try {
                    const output = await this.unitOfWork.execute(
                        async (repositories) => {
                            const [pending] =
                                await repositories.transactions.findPendingReferences(
                                    at,
                                    1,
                                );

                            if (!pending) {
                                return null;
                            }

                            selectedId = pending.id;

                            return this.processWagerTransaction.processPendingReference(
                                repositories,
                                pending,
                                at,
                            );
                        },
                    );

                    if (!selectedId) {
                        break;
                    }

                    result.attempted++;

                    if (!output) {
                        continue;
                    }

                    if (output.status === WagerTransactionStatus.PROCESSED) {
                        result.processed++;
                        metrics.transactionsTotal.inc({ status: output.status, kind: 'REVERSAL', source: 'reference_retry' });
                    } else if (
                        output.status === WagerTransactionStatus.REJECTED ||
                        output.status === WagerTransactionStatus.FAILED
                    ) {
                        result.rejected++;
                        metrics.transactionsTotal.inc({ status: output.status, kind: 'REVERSAL', source: 'reference_retry' });
                    } else {
                        result.deferred++;
                        metrics.retriesTotal.inc({ source: 'reference_retry' });
                    }
                } catch (error) {
                    if (!selectedId) {
                        throw error;
                    }

                    await this.scheduleTransientRetry(selectedId, at);
                    result.attempted++;
                    result.transientErrors++;
                    metrics.retriesTotal.inc({ source: 'reference_retry_error' });
                    this.logger.warn(
                        `Transient error while retrying reference transaction ${selectedId}: ${this.errorMessage(error)}`,
                    );
                }
            }

            return result;
        } finally {
            this.running = false;
        }
    }

    private async scheduleTransientRetry(
        transactionId: string,
        at: Date,
    ): Promise<void> {
        await this.unitOfWork.execute(async (repositories) => {
            const pending =
                await repositories.transactions.findByIdForUpdate(
                    transactionId,
                );

            if (
                !pending ||
                pending.status !== WagerTransactionStatus.PENDING_REFERENCE
            ) {
                return;
            }

            const expiresAt = pending.referenceExpiresAt;

            if (!expiresAt) {
                throw new Error(
                    `Pending reference transaction ${pending.id} has no expiration date.`,
                );
            }

            if (at.getTime() >= expiresAt.getTime()) {
                // Mesmo caminho do processamento normal: REJECTED/REFERENCE_EXPIRED
                // + WagerTransactionRejected no outbox, na mesma transação (seção 7.1).
                await this.processWagerTransaction.processPendingReference(
                    repositories,
                    pending,
                    at,
                );
                return;
            }

            const nextAttemptAt = this.retryPolicy.getNextAttemptAt(
                pending.referenceAttempts + 1,
                at,
            );

            pending.recordReferenceAttempt(
                new Date(
                    Math.min(nextAttemptAt.getTime(), expiresAt.getTime()),
                ),
            );

            await repositories.transactions.save(pending);
        });
    }

    private async runScheduledBatch(): Promise<void> {
        try {
            const result = await this.processBatch();
            if (result.attempted > 0) {
                this.logger.log(
                    `Reference retry batch completed: ${JSON.stringify(result)}`,
                );
            }
        } catch (error) {
            this.logger.error(
                `Reference retry batch failed: ${this.errorMessage(error)}`,
                error instanceof Error ? error.stack : undefined,
            );
        }
    }

    private emptyResult(): ReferenceRetryBatchResult {
        return {
            attempted: 0,
            processed: 0,
            rejected: 0,
            deferred: 0,
            transientErrors: 0,
        };
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private readPositiveInteger(
        raw: string | undefined,
        fallback: number,
        variableName: string,
    ): number {
        if (raw === undefined || raw.trim() === '') {
            return fallback;
        }

        const value = Number(raw);

        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new Error(`${variableName} must be a positive integer.`);
        }

        return value;
    }
}
