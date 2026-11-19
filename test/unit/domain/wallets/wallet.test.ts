import { describe, expect, it } from 'bun:test';
import { Money } from '../../../../src/domain/money/money.js';
import { Wallet } from '../../../../src/domain/wallets/wallet.js';

describe('Wallet', () => {
  describe('create and open', () => {
    it('creates a wallet with zero balance and initial version 1', () => {
      const wallet = Wallet.create('wallet-1', 'player-1', 'BRL');

      expect(wallet.id).toBe('wallet-1');
      expect(wallet.playerId).toBe('player-1');
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.toString()).toBe('0.00');
      expect(wallet.version).toBe(1);
    });

    it('opens a wallet with the provided initial balance', () => {
      const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.create('100.00', 'BRL'),
      });

      expect(wallet.balance.toString()).toBe('100.00');
      expect(wallet.version).toBe(1);
    });

    it('rejects an empty wallet id', () => {
      expect(() => Wallet.create(' ', 'player-1', 'BRL')).toThrow();
    });

    it('rejects an empty player id', () => {
      expect(() => Wallet.create('wallet-1', ' ', 'BRL')).toThrow();
    });

    it('rejects a negative initial balance', () => {
      expect(() => Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.create('-0.01', 'BRL'),
      })).toThrow();
    });
  });

  describe('credit', () => {
    it('increases balance and version', () => {
      const wallet = Wallet.create('wallet-1', 'player-1', 'BRL');

      wallet.credit(Money.create('50.00', 'BRL'));

      expect(wallet.balance.toString()).toBe('50.00');
      expect(wallet.version).toBe(2);
    });

    it('rejects a zero credit', () => {
      const wallet = Wallet.create('wallet-1', 'player-1', 'BRL');

      expect(() => wallet.credit(Money.zero('BRL'))).toThrow();
      expect(wallet.balance.toString()).toBe('0.00');
      expect(wallet.version).toBe(1);
    });

    it('rejects a negative credit', () => {
      const wallet = Wallet.create('wallet-1', 'player-1', 'BRL');

      expect(() => wallet.credit(Money.create('-1.00', 'BRL'))).toThrow();
      expect(wallet.balance.toString()).toBe('0.00');
      expect(wallet.version).toBe(1);
    });

    it('rejects credit with a different currency', () => {
      const wallet = Wallet.create('wallet-1', 'player-1', 'BRL');

      expect(() => wallet.credit(Money.create('1.00', 'USD'))).toThrow();
    });
  });

  describe('debit', () => {
    it('decreases balance and increases version', () => {
      const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.create('100.00', 'BRL'),
      });

      wallet.debit(Money.create('30.00', 'BRL'));

      expect(wallet.balance.toString()).toBe('70.00');
      expect(wallet.version).toBe(2);
    });

    it('allows debiting the exact balance', () => {
      const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.create('10.00', 'BRL'),
      });

      wallet.debit(Money.create('10.00', 'BRL'));

      expect(wallet.balance.toString()).toBe('0.00');
      expect(wallet.version).toBe(2);
    });

    it('rejects a debit greater than the balance without changing state', () => {
      const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.create('50.00', 'BRL'),
      });

      expect(() => wallet.debit(Money.create('50.01', 'BRL'))).toThrow();
      expect(wallet.balance.toString()).toBe('50.00');
      expect(wallet.version).toBe(1);
    });

    it('rejects zero and negative debits', () => {
      const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.create('10.00', 'BRL'),
      });

      expect(() => wallet.debit(Money.zero('BRL'))).toThrow();
      expect(() => wallet.debit(Money.create('-1.00', 'BRL'))).toThrow();
      expect(wallet.balance.toString()).toBe('10.00');
      expect(wallet.version).toBe(1);
    });
  });

  describe('rehydrate', () => {
    it('rehydrates a valid wallet', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: Money.create('25.50', 'BRL'),
        version: 4,
      });

      expect(wallet.balance.toString()).toBe('25.50');
      expect(wallet.version).toBe(4);
    });

    it('rejects an empty id or player id', () => {
      const base = {
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: Money.create('1.00', 'BRL'),
        version: 1,
      };

      expect(() => Wallet.rehydrate({ ...base, id: ' ' })).toThrow();
      expect(() => Wallet.rehydrate({ ...base, playerId: ' ' })).toThrow();
    });

    it('rejects a balance whose currency differs from wallet currency', () => {
      expect(() => Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: Money.create('1.00', 'USD'),
        version: 1,
      })).toThrow();
    });

    it('rejects a negative balance', () => {
      expect(() => Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: Money.create('-1.00', 'BRL'),
        version: 1,
      })).toThrow();
    });

    it.each([-1, 1.5, Number.NaN])('rejects invalid version %s', (version) => {
      expect(() => Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: Money.zero('BRL'),
        version,
      })).toThrow();
    });
  });
});
