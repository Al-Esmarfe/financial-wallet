import { WagerTransactionType } from '../../domain/transactions/wager-transaction-type.js';
import { ApplicationValidationError } from '../errors/application-errors.js';

export interface WagerCommandMoney {
    amount: string;
    currency: string;
}

/** Campos de negócio de uma operação de aposta, como chegam do provedor. */
export interface WagerCommand {
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionType;
    referenceExternalTransactionId?: string;
    money: WagerCommandMoney;
}

const PUBLIC_KINDS: readonly WagerTransactionType[] = [
    WagerTransactionType.BET,
    WagerTransactionType.WIN,
    WagerTransactionType.LOSS,
    WagerTransactionType.REFUND,
    WagerTransactionType.ROLLBACK,
];

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertPlainObject(
    value: unknown,
    field: string,
): asserts value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ApplicationValidationError(`${field} must be a JSON object.`);
    }
}

export function requireString(value: unknown, field: string, max = 150): string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
        throw new ApplicationValidationError(
            `${field} must be a non-empty string with at most ${max} characters.`,
        );
    }
    return value.trim();
}

export function requireUuid(value: unknown, field: string): string {
    const id = requireString(value, field, 36);
    if (!UUID_PATTERN.test(id)) {
        throw new ApplicationValidationError(`${field} must be a valid UUID.`);
    }
    return id;
}

/**
 * Money de entrada: string decimal não negativa, no máximo 2 casas, sem
 * notação científica, sem number JSON. (Valores negativos só existem
 * internamente, como resultado de aritmética de domínio.)
 */
export function requireMoney(value: unknown, field = 'money'): WagerCommandMoney {
    assertPlainObject(value, field);
    const amount = requireString(value.amount, `${field}.amount`, 40);
    const currency = requireString(value.currency, `${field}.currency`, 3);
    if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(amount)) {
        throw new ApplicationValidationError(
            `${field}.amount must be a non-negative decimal string with at most 2 decimal places.`,
        );
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
        throw new ApplicationValidationError(
            `${field}.currency must be a 3-letter uppercase ISO currency code.`,
        );
    }
    return { amount, currency };
}

/** Validação compartilhada por HTTP e SQS: ambos entram pelo mesmo contrato. */
export function validateWagerCommand(value: unknown): WagerCommand {
    assertPlainObject(value, 'body');

    const kind = requireString(value.kind, 'kind', 30) as WagerTransactionType;
    if (!PUBLIC_KINDS.includes(kind)) {
        throw new ApplicationValidationError(
            'kind must be BET, WIN, LOSS, REFUND or ROLLBACK. OPENING is internal.',
        );
    }

    const referenceExternalTransactionId =
        value.referenceExternalTransactionId === undefined ||
        value.referenceExternalTransactionId === null
            ? undefined
            : requireString(
                  value.referenceExternalTransactionId,
                  'referenceExternalTransactionId',
                  150,
              );

    if (
        (kind === WagerTransactionType.REFUND || kind === WagerTransactionType.ROLLBACK) &&
        !referenceExternalTransactionId
    ) {
        throw new ApplicationValidationError(
            `${kind} requires referenceExternalTransactionId.`,
        );
    }

    const money = requireMoney(value.money);

    return {
        providerId: requireString(value.providerId, 'providerId', 100),
        externalTransactionId: requireString(
            value.externalTransactionId,
            'externalTransactionId',
            150,
        ),
        playerId: requireString(value.playerId, 'playerId', 128),
        walletId: requireUuid(value.walletId, 'walletId'),
        roundId: requireString(value.roundId, 'roundId', 150),
        gameId: requireString(value.gameId, 'gameId', 150),
        kind,
        ...(referenceExternalTransactionId ? { referenceExternalTransactionId } : {}),
        money,
    };
}

/** Subconjunto de campos de negócio que entra no payloadHash (header/transporte ficam de fora). */
export function businessPayloadOf(command: WagerCommand): Record<string, unknown> {
    return {
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        playerId: command.playerId,
        walletId: command.walletId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        referenceExternalTransactionId: command.referenceExternalTransactionId ?? null,
        money: { amount: command.money.amount, currency: command.money.currency },
    };
}
