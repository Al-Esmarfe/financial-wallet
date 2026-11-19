import { WagerTransactionFailureCode } from '../../../../src/domain/transactions/wager-transaction-failure-code.js';
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../../src/domain/money/money.js';
import { Wallet } from '../../../../src/domain/wallets/wallet.js';
import { WagerTransaction } from '../../../../src/domain/transactions/wager-transaction.js';
import { WagerTransactionType } from '../../../../src/domain/transactions/wager-transaction-type.js';
import {
    CurrencyMismatchError,
    InsufficientFundsError,
    InvalidMoneyError,
    InvalidTransactionStateError,
    InvariantViolationError,
} from '../../../../src/domain/errors/domain-errors.js';

describe('typed domain errors', () => {
    it('Money: malformed input → InvalidMoneyError; mixed currencies → CurrencyMismatchError', () => {
        expect(() => Money.create('1e3', 'BRL')).toThrow(InvalidMoneyError);
        expect(() => Money.create('1.999', 'BRL')).toThrow(InvalidMoneyError);
        expect(() => Money.create('1.00', 'br')).toThrow(InvalidMoneyError);
        expect(() => Money.create('1.00', 'BRL').add(Money.create('1.00', 'USD'))).toThrow(CurrencyMismatchError);
    });

    it('Wallet: overdraft → InsufficientFundsError; wrong currency → CurrencyMismatchError', () => {
        const wallet = Wallet.open({ id: 'w', playerId: 'p', initialBalance: Money.create('10.00', 'BRL') });
        expect(() => wallet.debit(Money.create('10.01', 'BRL'))).toThrow(InsufficientFundsError);
        expect(() => wallet.credit(Money.create('1.00', 'USD'))).toThrow(CurrencyMismatchError);
        expect(wallet.balance.toString()).toBe('10.00'); // falha não altera o estado
        expect(wallet.version).toBe(1);
    });

    it('Wallet: empty identifiers → InvariantViolationError', () => {
        expect(() => Wallet.create(' ', 'p', 'BRL')).toThrow(InvariantViolationError);
    });

    it('WagerTransaction: changing a terminal transaction → InvalidTransactionStateError (a programming error)', () => {
        const tx = WagerTransaction.create({
            id: 't', providerId: 'p', providerTransactionId: 'e', playerId: 'pl', walletId: 'w', roundId: 'r', gameId: 'g',
            type: WagerTransactionType.BET, amount: Money.create('1.00', 'BRL'), idempotencyKey: 'k', requestHash: 'h',
        });
        tx.markProcessed();
        expect(() => tx.reject('late', WagerTransactionFailureCode.INVALID_TRANSACTION)).toThrow(InvalidTransactionStateError);
        expect(() => tx.fail('late')).toThrow(InvalidTransactionStateError);
    });

    it('every domain error carries a stable code and its class name', () => {
        const error = new InsufficientFundsError();
        expect(error.code).toBe('INSUFFICIENT_FUNDS');
        expect(error.name).toBe('InsufficientFundsError');
        expect(error).toBeInstanceOf(Error);
    });
});

describe('Money additions', () => {
    it('from() accepts the contract DTO and toJSON() round-trips it as strings (never number)', () => {
        const money = Money.from({ amount: '25.00', currency: 'BRL' });
        expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
        expect(JSON.stringify({ money })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
    });

    it('negate() returns a new instance; isNegative() reflects the sign', () => {
        const ten = Money.create('10.00', 'BRL');
        const negated = ten.negate();
        expect(negated.toString()).toBe('-10.00');
        expect(negated.isNegative()).toBe(true);
        expect(ten.isNegative()).toBe(false);
        expect(ten.toString()).toBe('10.00'); // imutável
        expect(negated.negate().equals(ten)).toBe(true);
    });

    it('avoids binary floating point errors', () => {
        expect(Money.create('0.10', 'BRL').add(Money.create('0.20', 'BRL')).toString()).toBe('0.30');
    });
});
