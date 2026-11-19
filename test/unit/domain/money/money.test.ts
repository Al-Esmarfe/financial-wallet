import { describe, expect, it } from 'bun:test';
import { Money } from '../../../../src/domain/money/money.js';

describe('Money', () => {
  describe('create', () => {
    it('creates a money value with two decimal places', () => {
      expect(Money.create('10', 'BRL').toString()).toBe('10.00');
      expect(Money.create('10.5', 'BRL').toString()).toBe('10.50');
      expect(Money.create('10.55', 'BRL').toString()).toBe('10.55');
    });

    it('accepts negative values as a general money value', () => {
      expect(Money.create('-10.25', 'BRL').toString()).toBe('-10.25');
    });

    it.each(['', 'abc', '1,25', '1.234', '1.234,56', '1.2.3', '+1.00', ' 1.00', '1.00 '])(
      'rejects invalid amount format: %s',
      (amount) => {
        expect(() => Money.create(amount, 'BRL')).toThrow();
      },
    );

    it.each(['brl', 'BR', 'BRLL', '1RL', '', ' B R'])(
      'rejects invalid currency code: %s',
      (currency) => {
        expect(() => Money.create('10.00', currency)).toThrow();
      },
    );

    it('creates zero for a valid currency', () => {
      expect(Money.zero('BRL').toString()).toBe('0.00');
      expect(Money.zero('USD').currency).toBe('USD');
    });
  });

  describe('arithmetic', () => {
    it('adds decimal values without floating-point precision loss', () => {
      const result = Money.create('0.10', 'BRL').add(Money.create('0.20', 'BRL'));
      expect(result.toString()).toBe('0.30');
    });

    it('subtracts decimal values', () => {
      const result = Money.create('10.00', 'BRL').subtract(Money.create('3.25', 'BRL'));
      expect(result.toString()).toBe('6.75');
    });

    it('does not mutate the original values during arithmetic', () => {
      const first = Money.create('10.00', 'BRL');
      const second = Money.create('2.00', 'BRL');

      first.add(second);

      expect(first.toString()).toBe('10.00');
      expect(second.toString()).toBe('2.00');
    });

    it('rejects addition with different currencies', () => {
      expect(() => Money.create('10.00', 'BRL').add(Money.create('1.00', 'USD'))).toThrow();
    });

    it('rejects subtraction with different currencies', () => {
      expect(() => Money.create('10.00', 'BRL').subtract(Money.create('1.00', 'USD'))).toThrow();
    });
  });

  describe('comparisons', () => {
    it('compares greater-than and less-than values', () => {
      const ten = Money.create('10.00', 'BRL');
      const five = Money.create('5.00', 'BRL');

      expect(ten.isGreaterThan(five)).toBe(true);
      expect(five.isLessThan(ten)).toBe(true);
    });

    it('compares equality including currency', () => {
      expect(Money.create('10.0', 'BRL').equals(Money.create('10.00', 'BRL'))).toBe(true);
      expect(Money.create('10.00', 'BRL').equals(Money.create('10.00', 'USD'))).toBe(false);
      expect(Money.create('10.00', 'BRL').equals(Money.create('10.01', 'BRL'))).toBe(false);
    });

    it('rejects ordered comparisons with different currencies', () => {
      const brl = Money.create('10.00', 'BRL');
      const usd = Money.create('10.00', 'USD');

      expect(() => brl.isGreaterThan(usd)).toThrow();
      expect(() => brl.isLessThan(usd)).toThrow();
    });

    it('identifies zero and positive values', () => {
      expect(Money.zero('BRL').isZero()).toBe(true);
      expect(Money.zero('BRL').isPositive()).toBe(false);
      expect(Money.create('0.01', 'BRL').isPositive()).toBe(true);
      expect(Money.create('-0.01', 'BRL').isPositive()).toBe(false);
    });
  });
});
