import {
    Inject,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
    ChangeMessageVisibilityCommand,
    DeleteMessageCommand,
    ReceiveMessageCommand,
    SendMessageCommand,
    SQSClient,
} from '@aws-sdk/client-sqs';
import type { Message } from '@aws-sdk/client-sqs';

import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { ReceivedInboxMessage } from '../ports/inbox-message.repository.js';
import { InboxMessage } from '../../domain/messaging/inbox-message.js';
import { UNIT_OF_WORK } from '../ports/tokens.js';
import { SQS_CLIENT } from '../../infrastructure/messaging/sqs/sqs-client.provider.js';
import { ProcessWagerTransactionUseCase } from '../use-cases/wagering/process-wager-transaction.use-case.js';
import {
    messagingConfig,
    positiveIntegerFromEnv,
} from '../messaging/messaging.config.js';
import {
    parseWagerTransactionRequested,
    type ParsedWagerTransactionRequested,
} from '../messaging/wager-transaction-requested.message.js';
import {
    classifyConsumerError,
    computeRetryDelaySeconds,
    errorCodeOf,
} from '../messaging/error-classification.js';
import { sha256Hex } from '../validation/canonical-json.js';
import { metrics } from '../../infrastructure/observability/metrics.js';
import {
    bindLogContext,
    runWithLogContext,
} from '../../infrastructure/observability/request-context.js';

export const INBOX_CONSUMER_NAME = 'wager-transactions-consumer';

export interface InboxBatchResult {
    received: number;
    processed: number;
    duplicates: number;
    /** Recusas de negócio terminais (ack). */
    rejected: number;
    /** Mensagens enviadas à DLQ (permanentes ou limite de recebimentos). */
    deadLettered: number;
    /** Falhas transitórias: não confirmadas, voltarão com backoff. */
    failed: number;
}

/**
 * Consumer da fila de entrada `wager-transactions.fifo`.
 *
 * Garantias:
 *  - Reusa o MESMO caso de uso do HTTP; Inbox + saldo + ledger + outbox no mesmo commit.
 *  - Deduplicação persistente por (consumerName, messageId do envelope).
 *  - Ack (DeleteMessage) somente depois do commit.
 *  - Erros classificados: permanente → DLQ; negócio → ack; transitório → retry com backoff.
 *  - Shutdown cooperativo: para de receber, termina a mensagem em andamento e devolve as demais.
 */
@Injectable()
export class InboxConsumerWorker implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(InboxConsumerWorker.name);
    private readonly intervalMs = positiveIntegerFromEnv('INBOX_POLL_INTERVAL_MS', 1_000);
    private readonly visibilityTimeoutSeconds = positiveIntegerFromEnv(
        'INBOX_VISIBILITY_TIMEOUT_SECONDS',
        60,
    );
    private readonly waitTimeSeconds = this.nonNegativeInteger(
        process.env.INBOX_WAIT_TIME_SECONDS,
        5,
    );
    /** Alinhado ao maxReceiveCount do redrive da fila (init-queues.sh). */
    private readonly maxReceiveCount = positiveIntegerFromEnv('INBOX_MAX_RECEIVE_COUNT', 5);

    private stopping = false;
    private running = false;
    private receiving?: AbortController;
    private loopPromise?: Promise<void>;
    private wakeUp?: () => void;

    constructor(
        @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
        private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
        @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    ) {}

    onModuleInit(): void {
        if (!messagingConfig.inboundQueueUrl()) {
            this.logger.warn(
                JSON.stringify({ event: 'inbox_consumer_disabled', reason: 'inbound queue URL is not configured' }),
            );
            return;
        }
        this.loopPromise = this.loop();
    }

    /** SIGTERM: para de receber, deixa o lote em andamento terminar e devolve o resto. */
    async onModuleDestroy(): Promise<void> {
        this.stopping = true;
        this.receiving?.abort(); // interrompe o long poll, se estiver esperando mensagens
        this.wakeUp?.(); // acorda o loop se estiver dormindo entre lotes
        await this.loopPromise;
        // Sem loop (ex.: consumeBatch chamado manualmente), ainda assim espera o lote ativo.
        while (this.running) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    async consumeBatch(): Promise<InboxBatchResult> {
        const result = this.emptyResult();
        const queueUrl = messagingConfig.inboundQueueUrl();
        if (!queueUrl || this.running || this.stopping) return result;

        this.running = true;
        try {
            const messages = await this.receive(queueUrl);
            result.received = messages.length;

            for (let index = 0; index < messages.length; index++) {
                if (this.stopping) {
                    // Devolve as não iniciadas: visibilidade 0 = disponíveis para outra instância já.
                    await this.releaseMessages(queueUrl, messages.slice(index));
                    break;
                }
                await this.handleMessage(queueUrl, messages[index]!, result);
            }
            return result;
        } finally {
            this.running = false;
        }
    }

    // ---------------------------------------------------------------- receive

    private async receive(queueUrl: string): Promise<Message[]> {
        const controller = new AbortController();
        this.receiving = controller;
        try {
            const response = await this.sqs.send(
                new ReceiveMessageCommand({
                    QueueUrl: queueUrl,
                    MaxNumberOfMessages: 10,
                    WaitTimeSeconds: this.waitTimeSeconds,
                    VisibilityTimeout: this.visibilityTimeoutSeconds,
                    MessageSystemAttributeNames: ['MessageGroupId', 'ApproximateReceiveCount'],
                }),
                { abortSignal: controller.signal } as never,
            );
            return response.Messages ?? [];
        } catch (error) {
            if (this.stopping || (error as Error)?.name === 'AbortError') return [];
            throw error;
        } finally {
            this.receiving = undefined;
        }
    }

    private async releaseMessages(queueUrl: string, messages: Message[]): Promise<void> {
        for (const message of messages) {
            if (!message.ReceiptHandle) continue;
            try {
                await this.sqs.send(
                    new ChangeMessageVisibilityCommand({
                        QueueUrl: queueUrl,
                        ReceiptHandle: message.ReceiptHandle,
                        VisibilityTimeout: 0,
                    }),
                );
            } catch (error) {
                this.logger.warn(
                    JSON.stringify({ event: 'inbox_release_failed', sqsMessageId: message.MessageId, error: this.message(error) }),
                );
            }
        }
    }

    // ---------------------------------------------------------------- handling

    private async handleMessage(
        queueUrl: string,
        message: Message,
        result: InboxBatchResult,
    ): Promise<void> {
        if (!message.ReceiptHandle) {
            result.failed++;
            return;
        }

        await runWithLogContext(
            { correlationId: message.MessageId ?? randomUUID(), messageId: message.MessageId },
            async () => {
                let parsed: ParsedWagerTransactionRequested | undefined;
                try {
                    parsed = parseWagerTransactionRequested(message.Body ?? '');
                    // O messageId lógico passa a ser o identificador de correlação.
                    bindLogContext({ correlationId: parsed.messageId, messageId: parsed.messageId });

                    const terminal = await this.findTerminalStatus(parsed.messageId);
                    if (terminal) {
                        // Já recusada/encaminhada à DLQ antes: apenas confirma a duplicata.
                        await this.deleteMessage(queueUrl, message.ReceiptHandle!);
                        result.duplicates++;
                        metrics.inboxMessagesTotal.inc({ result: 'duplicate' });
                        return;
                    }

                    const output = await this.processWagerTransaction.execute(parsed.input, {
                        consumerName: INBOX_CONSUMER_NAME,
                        messageId: parsed.messageId,
                        messageGroupId: message.Attributes?.MessageGroupId,
                        payloadHash: parsed.payloadHash,
                        payload: parsed.envelope,
                    });

                    // Ack SOMENTE depois do commit (execute() só retorna após o commit).
                    await this.deleteMessage(queueUrl, message.ReceiptHandle!);
                    if (output.idempotentReplay) {
                        result.duplicates++;
                        metrics.inboxMessagesTotal.inc({ result: 'duplicate' });
                    } else {
                        result.processed++;
                        metrics.inboxMessagesTotal.inc({ result: 'processed' });
                    }
                } catch (error) {
                    await this.handleFailure(queueUrl, message, parsed, error, result);
                }
            },
        );
    }

    private async handleFailure(
        queueUrl: string,
        message: Message,
        parsed: ParsedWagerTransactionRequested | undefined,
        error: unknown,
        result: InboxBatchResult,
    ): Promise<void> {
        const errorClass = classifyConsumerError(error);
        const code = errorCodeOf(error);
        const reason = `${code}: ${this.message(error)}`;
        const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1') || 1;
        const stub = this.stubFor(message, parsed);

        this.logger.warn(
            JSON.stringify({
                event: 'inbox_message_failed',
                errorClass,
                errorCode: code,
                receiveCount,
                sqsMessageId: message.MessageId,
            }),
        );

        try {
            if (errorClass === 'BUSINESS_TERMINAL') {
                await this.recordOutcome(stub, 'REJECTED', reason);
                await this.deleteMessage(queueUrl, message.ReceiptHandle!);
                result.rejected++;
                metrics.inboxMessagesTotal.inc({ result: 'business_rejected' });
                return;
            }

            if (errorClass === 'PERMANENT') {
                await this.deadLetter(queueUrl, message, stub, `PERMANENT:${code}`, reason, result);
                return;
            }

            // TRANSIENT
            if (receiveCount >= this.maxReceiveCount) {
                await this.deadLetter(queueUrl, message, stub, 'MAX_RECEIVE_COUNT_EXCEEDED', reason, result);
                return;
            }

            await this.recordOutcome(stub, 'FAILED', reason);
            await this.sqs.send(
                new ChangeMessageVisibilityCommand({
                    QueueUrl: queueUrl,
                    ReceiptHandle: message.ReceiptHandle!,
                    VisibilityTimeout: computeRetryDelaySeconds(receiveCount),
                }),
            );
            result.failed++;
            metrics.retriesTotal.inc({ source: 'sqs_inbound' });
            metrics.inboxMessagesTotal.inc({ result: 'transient_error' });
        } catch (handlingError) {
            // Falha ao tratar a falha (ex.: PostgreSQL ou SQS fora): nada é confirmado.
            // A mensagem reaparece após o visibility timeout e o ciclo recomeça.
            result.failed++;
            metrics.inboxMessagesTotal.inc({ result: 'transient_error' });
            this.logger.error(
                JSON.stringify({
                    event: 'inbox_failure_handling_failed',
                    sqsMessageId: message.MessageId,
                    error: this.message(handlingError),
                }),
            );
        }
    }

    /** DLQ → registra na Inbox → só então remove o original (nunca perde a mensagem). */
    private async deadLetter(
        queueUrl: string,
        message: Message,
        stub: ReceivedInboxMessage,
        deadLetterReason: string,
        detail: string,
        result: InboxBatchResult,
    ): Promise<void> {
        const dlqUrl = messagingConfig.inboundDlqUrl();
        if (!dlqUrl) {
            // Sem DLQ configurada, o redrive nativo da fila assume depois do limite.
            await this.recordOutcome(stub, 'FAILED', detail);
            result.failed++;
            this.logger.error(
                JSON.stringify({ event: 'dlq_not_configured', deadLetterReason, sqsMessageId: message.MessageId }),
            );
            return;
        }

        await this.sqs.send(
            new SendMessageCommand({
                QueueUrl: dlqUrl,
                MessageBody: message.Body ?? '',
                MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
                MessageDeduplicationId: `dlq:${sha256Hex(stub.messageId)}`,
                MessageAttributes: {
                    DeadLetterReason: { DataType: 'String', StringValue: deadLetterReason },
                    OriginalSqsMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
                },
            }),
        );
        await this.recordOutcome(stub, 'DEAD_LETTERED', detail);
        await this.deleteMessage(queueUrl, message.ReceiptHandle!);

        result.deadLettered++;
        metrics.dlqMessagesTotal.inc({ queue: 'wager-transactions', reason: deadLetterReason.split(':')[0]! });
        metrics.inboxMessagesTotal.inc({ result: 'dead_lettered' });
        this.logger.error(
            JSON.stringify({ event: 'message_dead_lettered', deadLetterReason, errorDetail: detail }),
        );
    }

    // ---------------------------------------------------------------- persistence helpers

    private stubFor(
        message: Message,
        parsed: ParsedWagerTransactionRequested | undefined,
    ): ReceivedInboxMessage {
        const body = message.Body ?? '';
        return InboxMessage.receive({
            id: randomUUID(),
            consumerName: INBOX_CONSUMER_NAME,
            // Corpo ilegível: usa o MessageId do SQS como chave de auditoria.
            messageId: parsed?.messageId ?? `sqs:${message.MessageId ?? randomUUID()}`,
            messageGroupId: message.Attributes?.MessageGroupId,
            payloadHash: parsed?.payloadHash ?? sha256Hex(body),
            payload: parsed?.envelope ?? { rawBody: body.slice(0, 4000) },
            receivedAt: new Date(),
        });
    }

    private async recordOutcome(
        stub: ReceivedInboxMessage,
        outcome: 'FAILED' | 'REJECTED' | 'DEAD_LETTERED',
        reason: string,
    ): Promise<void> {
        await this.unitOfWork.execute(async (repositories) => {
            await repositories.inbox!.recordOutcome(stub, outcome, reason);
        });
    }

    private async findTerminalStatus(messageId: string): Promise<string | null> {
        const status = await this.unitOfWork.execute((repositories) =>
            repositories.inbox!.findStatus(INBOX_CONSUMER_NAME, messageId),
        );
        return status === 'REJECTED' || status === 'DEAD_LETTERED' ? status : null;
    }

    private async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
        await this.sqs.send(
            new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
        );
    }

    // ---------------------------------------------------------------- loop

    private async loop(): Promise<void> {
        while (!this.stopping) {
            let received = 0;
            try {
                const result = await this.consumeBatch();
                received = result.received;
                if (received > 0) {
                    this.logger.log(JSON.stringify({ event: 'inbox_batch', ...result }));
                }
            } catch (error) {
                this.logger.error(
                    JSON.stringify({ event: 'inbox_batch_failed', error: this.message(error) }),
                );
            }
            // Fila com mensagens: drena sem pausa. Vazia ou com erro: respira.
            if (received === 0 && !this.stopping) {
                await this.sleep(this.intervalMs);
            }
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            this.wakeUp = () => {
                clearTimeout(timer);
                resolve();
            };
        });
    }

    private emptyResult(): InboxBatchResult {
        return { received: 0, processed: 0, duplicates: 0, rejected: 0, deadLettered: 0, failed: 0 };
    }

    private message(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private nonNegativeInteger(raw: string | undefined, fallback: number): number {
        if (!raw?.trim()) return fallback;
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error('INBOX_WAIT_TIME_SECONDS must be a non-negative integer.');
        }
        return value;
    }
}
