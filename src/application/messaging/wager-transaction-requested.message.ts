import type { ProcessWagerTransactionInput } from '../use-cases/wagering/dto/process-wager-transaction.input.js';
import {
    ApplicationValidationError,
    MalformedMessageError,
} from '../errors/application-errors.js';
import { canonicalStringify, sha256Hex } from '../validation/canonical-json.js';
import {
    assertPlainObject,
    businessPayloadOf,
    requireString,
    validateWagerCommand,
} from '../validation/wager-command.validation.js';

export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

export interface ParsedWagerTransactionRequested {
    /** messageId lógico do envelope: chave de deduplicação da Inbox. */
    messageId: string;
    occurredAt: Date;
    /** Entrada pronta para o mesmo caso de uso que atende o HTTP. */
    input: ProcessWagerTransactionInput;
    /** sha256 do JSON canônico dos campos de negócio (+ idempotencyKey). */
    payloadHash: string;
    /** Envelope já parseado, para auditoria na Inbox. */
    envelope: Record<string, unknown>;
}

/**
 * Valida e converte o corpo de uma mensagem SQS no formato do enunciado:
 *
 *   { "messageId": "msg-123", "type": "WagerTransactionRequested",
 *     "occurredAt": "2026-07-29T15:00:00.000Z",
 *     "data": { providerId, externalTransactionId, idempotencyKey, playerId,
 *               walletId, roundId, gameId, kind, [referenceExternalTransactionId], money } }
 *
 * Qualquer desvio lança erro de categoria VALIDATION (permanente): reenviar a
 * mesma mensagem nunca vai funcionar, então o consumer a encaminha à DLQ.
 */
export function parseWagerTransactionRequested(
    rawBody: string,
): ParsedWagerTransactionRequested {
    let envelope: unknown;
    try {
        envelope = JSON.parse(rawBody);
    } catch {
        throw new MalformedMessageError('Message body is not valid JSON.');
    }

    try {
        assertPlainObject(envelope, 'message');

        const messageId = requireString(envelope.messageId, 'messageId', 200);

        if (envelope.type !== WAGER_TRANSACTION_REQUESTED) {
            throw new ApplicationValidationError(
                `type must be ${WAGER_TRANSACTION_REQUESTED}.`,
            );
        }

        const occurredAtRaw = requireString(envelope.occurredAt, 'occurredAt', 40);
        const occurredAt = new Date(occurredAtRaw);
        if (Number.isNaN(occurredAt.getTime())) {
            throw new ApplicationValidationError('occurredAt must be an ISO-8601 date.');
        }

        assertPlainObject(envelope.data, 'data');
        const idempotencyKey = requireString(envelope.data.idempotencyKey, 'idempotencyKey', 150);
        const command = validateWagerCommand(envelope.data);

        return {
            messageId,
            occurredAt,
            input: { ...command, idempotencyKey },
            payloadHash: sha256Hex(
                canonicalStringify({ ...businessPayloadOf(command), idempotencyKey }),
            ),
            envelope: envelope as Record<string, unknown>,
        };
    } catch (error) {
        if (error instanceof ApplicationValidationError) {
            throw new MalformedMessageError(error.message);
        }
        throw error;
    }
}
