import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain-errors.js';

export interface MoneyProps {
    /** Decimal string com escala fixa de 2 casas, ex.: "25.00". */
    amount: string;
    /** Código ISO-4217, ex.: "BRL". */
    currency: string;
}

export class Money {
    private static readonly SCALE = 2;

    private constructor(
        private readonly amount: Decimal,
        public readonly currency: string,
    ) {}

    static create(amount: string, currency: string): Money {
        if (!/^-?\d+(\.\d{1,2})?$/.test(amount)) {
            throw new InvalidMoneyError(
                'Invalid monetary amount. Use a decimal string with up to 2 decimal places.',
            );
        }

        if (!/^[A-Z]{3}$/.test(currency)) {
            throw new InvalidMoneyError('Currency must contain 3 uppercase letters.');
        }

        const decimalAmount = new Decimal(amount);

        if (!decimalAmount.isFinite()) {
            throw new InvalidMoneyError('Monetary amount must be finite.');
        }

        return new Money(decimalAmount, currency);
    }

    /** Factory a partir do DTO de contrato ({ amount, currency }). */
    static from(props: MoneyProps): Money {
        return Money.create(props.amount, props.currency);
    }

    static zero(currency: string): Money {
        return Money.create('0.00', currency);
    }

    add(other: Money): Money {
        this.ensureSameCurrency(other);

        return new Money(this.amount.plus(other.amount), this.currency);
    }

    subtract(other: Money): Money {
        this.ensureSameCurrency(other);

        return new Money(this.amount.minus(other.amount), this.currency);
    }

    /** Valor com sinal invertido (nova instância; Money é imutável). */
    negate(): Money {
        return new Money(new Decimal(0).minus(this.amount), this.currency);
    }

    isGreaterThan(other: Money): boolean {
        this.ensureSameCurrency(other);
        return this.amount.greaterThan(other.amount);
    }

    isLessThan(other: Money): boolean {
        this.ensureSameCurrency(other);
        return this.amount.lessThan(other.amount);
    }

    equals(other: Money): boolean {
        return (
            this.currency === other.currency && this.amount.equals(other.amount)
        );
    }

    isZero(): boolean {
        return this.amount.isZero();
    }

    isPositive(): boolean {
        return this.amount.greaterThan(0);
    }

    isNegative(): boolean {
        return this.amount.lessThan(0);
    }

    /** Serialização estável para contratos e payloads de eventos: nunca number. */
    toJSON(): MoneyProps {
        return { amount: this.toString(), currency: this.currency };
    }

    toString(): string {
        return this.amount.toFixed(Money.SCALE);
    }

    private ensureSameCurrency(other: Money): void {
        if (this.currency !== other.currency) {
            throw new CurrencyMismatchError(
                `Currency mismatch: ${this.currency} and ${other.currency}`,
            );
        }
    }
}
