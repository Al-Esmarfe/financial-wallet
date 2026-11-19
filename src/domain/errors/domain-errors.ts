/**
 * Erros de domínio tipados.
 *
 * Cada erro carrega um `code` estável e legível por máquina. As camadas externas
 * (HTTP, consumer SQS) decidem o tratamento com `instanceof` / `code`, e nunca
 * com expressões regulares sobre a mensagem — mensagens podem mudar, tipos não.
 */
export abstract class DomainError extends Error {
    abstract readonly code: string;

    protected constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

/** Valor monetário malformado: escala, notação, moeda inválida, não finito. */
export class InvalidMoneyError extends DomainError {
    readonly code = 'INVALID_MONEY';

    constructor(message: string) {
        super(message);
    }
}

/** Operação entre moedas diferentes (Money x Money, ou Money x Wallet). */
export class CurrencyMismatchError extends DomainError {
    readonly code = 'CURRENCY_MISMATCH';

    constructor(message: string) {
        super(message);
    }
}

/** Débito que levaria o saldo abaixo de zero. */
export class InsufficientFundsError extends DomainError {
    readonly code = 'INSUFFICIENT_FUNDS';

    constructor(message = 'Insufficient wallet balance.') {
        super(message);
    }
}

/**
 * Transição de estado inválida (ex.: alterar uma transação já terminal).
 * É erro de programação, não um caminho de negócio: nunca deve ser tratado
 * como rejeição de provedor.
 */
export class InvalidTransactionStateError extends DomainError {
    readonly code = 'INVALID_TRANSACTION_STATE';

    constructor(message: string) {
        super(message);
    }
}

/** Violação de invariante de um agregado (identificadores vazios, saldo negativo etc.). */
export class InvariantViolationError extends DomainError {
    readonly code = 'INVARIANT_VIOLATION';

    constructor(message: string) {
        super(message);
    }
}
