/**
 * Erros da camada de aplicação.
 *
 * `category` é o que adaptadores (HTTP e consumer SQS) usam para decidir o
 * tratamento, sem inspecionar mensagens:
 *
 *   VALIDATION → entrada malformada; reenviar o mesmo payload nunca vai funcionar
 *                (HTTP 400 / SQS: DLQ imediata)
 *   CONFLICT   → conflito de idempotência / identidade externa
 *                (HTTP 409 / SQS: ack — terminal, auditável)
 *   NOT_FOUND  → recurso inexistente (HTTP 404 / SQS: ack — terminal)
 *   BUSINESS   → recusa de regra de negócio levantada como exceção
 *                (HTTP 422 / SQS: ack — terminal)
 *
 * Qualquer outro erro é tratado como infraestrutura/transitório (HTTP 5xx,
 * SQS: não confirma a mensagem e deixa o retry com backoff agir).
 */
export type ErrorCategory = 'VALIDATION' | 'CONFLICT' | 'NOT_FOUND' | 'BUSINESS';

export abstract class ApplicationError extends Error {
    abstract readonly code: string;
    abstract readonly category: ErrorCategory;

    protected constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

export class ApplicationValidationError extends ApplicationError {
    readonly code = 'VALIDATION_ERROR';
    readonly category = 'VALIDATION' as const;

    constructor(message: string) {
        super(message);
    }
}

/** Mensagem SQS ilegível ou fora do contrato (JSON inválido, type desconhecido...). */
export class MalformedMessageError extends ApplicationError {
    readonly code = 'MALFORMED_MESSAGE';
    readonly category = 'VALIDATION' as const;

    constructor(message: string) {
        super(message);
    }
}

/** Mesmo messageId reenviado com payload diferente: mensagem envenenada. */
export class InboxPayloadMismatchError extends ApplicationError {
    readonly code = 'INBOX_PAYLOAD_MISMATCH';
    readonly category = 'VALIDATION' as const;

    constructor(messageId: string) {
        super(`Inbox message ${messageId} was already received with a different payload.`);
    }
}

export class IdempotencyConflictError extends ApplicationError {
    readonly code = 'IDEMPOTENCY_CONFLICT';
    readonly category = 'CONFLICT' as const;

    constructor() {
        super('The idempotency key was already used with a different payload.');
    }
}

export class ExternalTransactionConflictError extends ApplicationError {
    readonly code = 'EXTERNAL_TRANSACTION_CONFLICT';
    readonly category = 'CONFLICT' as const;

    constructor() {
        super('The provider transaction ID has already been used.');
    }
}

export class WalletNotFoundError extends ApplicationError {
    readonly code = 'WALLET_NOT_FOUND';
    readonly category = 'NOT_FOUND' as const;

    constructor(walletId: string) {
        super(`Wallet ${walletId} was not found.`);
    }
}

export class WalletOwnershipMismatchError extends ApplicationError {
    readonly code = 'WALLET_OWNERSHIP_MISMATCH';
    readonly category = 'BUSINESS' as const;

    constructor() {
        super('The wallet does not belong to the informed player or currency.');
    }
}

export class WalletAlreadyExistsError extends ApplicationError {
    readonly code = 'WALLET_ALREADY_EXISTS';
    readonly category = 'CONFLICT' as const;

    constructor() {
        super('A wallet already exists for this player and currency.');
    }
}
