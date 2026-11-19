import { Money } from '../money/money.js';
import { CurrencyMismatchError, InsufficientFundsError, InvariantViolationError } from '../errors/domain-errors.js';

export class Wallet {
    private constructor(
        public readonly id: string,
        public readonly playerId: string,
        public readonly currency: string,
        private currentBalance: Money,
        private currentVersion: number,
        public readonly createdAt: Date,
        private currentUpdatedAt: Date,
    ) {}

    static create(id: string, playerId: string, currency: string): Wallet {
        return Wallet.open({
            id,
            playerId,
            initialBalance: Money.zero(currency),
        });
    }

    static open(props: {
        id: string;
        playerId: string;
        initialBalance: Money;
        /** Instante de abertura (injetável para testes). */
        now?: Date;
    }): Wallet {
        const { id, playerId, initialBalance } = props;
        const now = props.now ? new Date(props.now) : new Date();

        if (!id.trim() || !playerId.trim()) {
            throw new InvariantViolationError('Wallet id and playerId are required.');
        }

        if (!initialBalance.currency.trim()) {
            throw new InvariantViolationError('Wallet currency is required.');
        }

        if (!initialBalance.isPositive() && !initialBalance.isZero()) {
            throw new InvariantViolationError('Initial balance cannot be negative.');
        }

        return new Wallet(
            id,
            playerId,
            initialBalance.currency,
            initialBalance,
            1,
            now,
            now,
        );
    }

    static rehydrate(data: {
        id: string;
        playerId: string;
        currency: string;
        balance: Money;
        version: number;
        createdAt?: Date;
        updatedAt?: Date;
    }): Wallet {
        if (!data.id.trim() || !data.playerId.trim()) {
            throw new InvariantViolationError('Wallet ID and Player ID are required.');
        }

        if (data.balance.currency !== data.currency) {
            throw new CurrencyMismatchError('Wallet currency does not match balance currency.');
        }

        if (!data.balance.isPositive() && !data.balance.isZero()) {
            throw new InvariantViolationError('Wallet balance cannot be negative.');
        }

        if (!Number.isInteger(data.version) || data.version < 0) {
            throw new InvariantViolationError('Wallet version must be a non-negative integer.');
        }

        return new Wallet(
            data.id,
            data.playerId,
            data.currency,
            data.balance,
            data.version,
            data.createdAt ? new Date(data.createdAt) : new Date(0),
            data.updatedAt ? new Date(data.updatedAt) : data.createdAt ? new Date(data.createdAt) : new Date(0),
        );
    }

    get balance(): Money {
        return this.currentBalance;
    }

    get version(): number {
        return this.currentVersion;
    }

    get updatedAt(): Date {
        return new Date(this.currentUpdatedAt);
    }

    credit(amount: Money): void {
        this.validateAmount(amount);

        const newBalance = this.currentBalance.add(amount);

        this.updateBalance(newBalance);
    }

    debit(amount: Money): void {
        this.validateAmount(amount);

        if (this.currentBalance.isLessThan(amount)) {
            throw new InsufficientFundsError('Insufficient wallet balance.');
        }

        const newBalance = this.currentBalance.subtract(amount);

        this.updateBalance(newBalance);
    }

    private validateAmount(amount: Money): void {
        if (amount.currency !== this.currency) {
            throw new CurrencyMismatchError(
                'Wallet currency does not match transaction currency.',
            );
        }

        if (!amount.isPositive()) {
            throw new InvariantViolationError('Transaction amount must be greater than zero.');
        }
    }

    private updateBalance(newBalance: Money): void {
        if (this.currentBalance.equals(newBalance)) {
            return;
        }

        this.currentBalance = newBalance;
        this.currentVersion++;
        this.currentUpdatedAt = new Date();
    }
}
