import { Money } from '../money/money.js';
import { WagerTransactionType } from '../transactions/wager-transaction-type.js';
import { LedgerEntryDirection } from './ledger-entry-direction.js';
import { CurrencyMismatchError, InvariantViolationError } from '../errors/domain-errors.js';

export { LedgerEntryDirection } from './ledger-entry-direction.js';

interface CreateLedgerEntryProps {
    id: string;
    walletId: string;
    transactionId: string;
    transactionType: WagerTransactionType;
    direction: LedgerEntryDirection;
    amount: Money;
    balanceBefore: Money;
    balanceAfter: Money;
    createdAt: string;
    /**
     * Posição do lançamento na sequência da wallet: a `version` da wallet logo
     * após a movimentação (1 = abertura). Define a ORDEM CANÔNICA do ledger —
     * relógios não servem: duas transações da mesma wallet podem ler `now()`
     * em uma ordem e obter o lock em outra.
     */
    walletVersion: number;
}

export class LedgerEntry {
    private constructor(
        public readonly id: string,
        public readonly walletId: string,
        public readonly transactionId: string,
        public readonly transactionType: WagerTransactionType,
        public readonly direction: LedgerEntryDirection,
        public readonly amount: Money,
        public readonly balanceAfter: Money,
        public readonly createdAt: string,
        public readonly balanceBefore: Money,
        public readonly walletVersion: number,
    ) {
        Object.freeze(this);
    }

    static create(props: CreateLedgerEntryProps): LedgerEntry {
        if (
            !props.id.trim() ||
            !props.walletId.trim() ||
            !props.transactionId.trim()
        ) {
            throw new InvariantViolationError('Ledger identifiers are required.');
        }

        if (!props.amount.isPositive()) {
            throw new InvariantViolationError('Ledger amount must be greater than zero.');
        }

        if (
            props.amount.currency !== props.balanceBefore.currency ||
            props.amount.currency !== props.balanceAfter.currency
        ) {
            throw new CurrencyMismatchError('Ledger currencies must match.');
        }

        if (
            props.balanceBefore.isLessThan(
                Money.zero(props.balanceBefore.currency),
            ) ||
            props.balanceAfter.isLessThan(
                Money.zero(props.balanceAfter.currency),
            )
        ) {
            throw new InvariantViolationError('Ledger balances cannot be negative.');
        }

        if (!Number.isSafeInteger(props.walletVersion) || props.walletVersion < 1) {
            throw new InvariantViolationError('Ledger wallet version must be a positive integer.');
        }

        if (Number.isNaN(Date.parse(props.createdAt))) {
            throw new InvariantViolationError('Invalid ledger creation date.');
        }

        const entry = new LedgerEntry(
            props.id,
            props.walletId,
            props.transactionId,
            props.transactionType,
            props.direction,
            props.amount,
            props.balanceAfter,
            props.createdAt,
            props.balanceBefore,
            props.walletVersion,
        );

        if (!entry.isBalanced()) {
            throw new InvariantViolationError('Ledger entry has an inconsistent balance');
        }

        return Object.freeze(entry);
    }

    isBalanced(): boolean {
        const expectedBalance =
            this.direction === LedgerEntryDirection.DEBIT
                ? this.balanceBefore.subtract(this.amount)
                : this.balanceBefore.add(this.amount);

        return expectedBalance.equals(this.balanceAfter);
    }

    static rehydrate(props: CreateLedgerEntryProps): LedgerEntry {
        return LedgerEntry.create(props);
    }
}
