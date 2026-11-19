import { ApplicationError } from '../errors/application-errors.js';
import {
    DomainError,
    InvalidTransactionStateError,
} from '../../domain/errors/domain-errors.js';

/**
 * Como o consumer SQS reage a uma exceção:
 *
 *   PERMANENT         mensagem inválida; nunca terá sucesso → DLQ imediata (+ ack do original)
 *   BUSINESS_TERMINAL recusa de negócio / conflito / recurso inexistente → ack, auditável na Inbox
 *   TRANSIENT         infraestrutura (PostgreSQL fora, timeout, deadlock...) → não confirma;
 *                     retry com backoff e DLQ ao estourar o limite de recebimentos
 *
 * Erro desconhecido é TRANSIENT de propósito: na dúvida, tenta de novo — a
 * idempotência persistente torna o reprocessamento seguro, e o limite de
 * recebimentos garante que não haja laço infinito.
 */
export type ConsumerErrorClass = 'PERMANENT' | 'BUSINESS_TERMINAL' | 'TRANSIENT';

export function classifyConsumerError(error: unknown): ConsumerErrorClass {
    if (error instanceof ApplicationError) {
        return error.category === 'VALIDATION' ? 'PERMANENT' : 'BUSINESS_TERMINAL';
    }
    if (error instanceof InvalidTransactionStateError) {
        // Erro de programação: não é culpa da mensagem. Retry (talvez um deploy corrija).
        return 'TRANSIENT';
    }
    if (error instanceof DomainError) {
        // Dinheiro/moeda/invariante inválidos vindos da mensagem.
        return 'PERMANENT';
    }
    return 'TRANSIENT';
}

export function errorCodeOf(error: unknown): string {
    if (error instanceof ApplicationError || error instanceof DomainError) {
        return error.code;
    }
    return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
}

/**
 * Atraso (segundos) de visibilidade antes da próxima entrega: 2s, 4s, 8s... com teto.
 * `receiveCount` é o ApproximateReceiveCount da mensagem (1 na primeira entrega).
 */
export function computeRetryDelaySeconds(
    receiveCount: number,
    baseSeconds = 2,
    capSeconds = 300,
): number {
    const attempt = Math.max(1, Math.floor(receiveCount));
    return Math.min(capSeconds, baseSeconds * 2 ** (attempt - 1));
}
