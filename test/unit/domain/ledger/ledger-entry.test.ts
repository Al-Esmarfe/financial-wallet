import { describe, expect, it } from 'bun:test';

import { Money } from '../../../../src/domain/money/money.js';
import {
    LedgerEntry,
    LedgerEntryDirection,
} from '../../../../src/domain/ledger/ledger-entry.js';
import { WagerTransactionType } from '../../../../src/domain/transactions/wager-transaction-type.js';

describe('LedgerEntry', () => {
    const validProps = () => ({
        id: 'ledger-1',
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        transactionType: WagerTransactionType.BET,
        direction: LedgerEntryDirection.DEBIT,
        amount: Money.create('10.00', 'BRL'),
        balanceBefore: Money.create('100.00', 'BRL'),
        balanceAfter: Money.create('90.00', 'BRL'),
        createdAt: '2026-11-18T12:00:00.000Z',
        walletVersion: 2,
    });

    describe('create', () => {
        it('creates a valid ledger entry', () => {
            const entry = LedgerEntry.create(validProps());

            expect(entry.id).toBe('ledger-1');
            expect(entry.walletId).toBe('wallet-1');
            expect(entry.transactionId).toBe('transaction-1');
            expect(entry.transactionType).toBe(WagerTransactionType.BET);
            expect(entry.direction).toBe(LedgerEntryDirection.DEBIT);
            expect(entry.amount.toString()).toBe('10.00');
            expect(entry.balanceAfter.toString()).toBe('90.00');
            expect(entry.createdAt).toBe('2026-11-18T12:00:00.000Z');
            expect(entry.walletVersion).toBe(2);
        });

        it.each([0, -1, 1.5, Number.NaN])(
            'rejects an invalid wallet version (%p)',
            (walletVersion) => {
                expect(() =>
                    LedgerEntry.create({ ...validProps(), walletVersion }),
                ).toThrow();
            },
        );

        it('rejects an empty id', () => {
            expect(() =>
                LedgerEntry.create({ ...validProps(), id: ' ' }),
            ).toThrow();
        });

        it('rejects an empty wallet id', () => {
            expect(() =>
                LedgerEntry.create({ ...validProps(), walletId: '' }),
            ).toThrow();
        });

        it('rejects an empty transaction id', () => {
            expect(() =>
                LedgerEntry.create({ ...validProps(), transactionId: '' }),
            ).toThrow();
        });

        it('rejects a zero amount', () => {
            expect(() =>
                LedgerEntry.create({
                    ...validProps(),
                    amount: Money.zero('BRL'),
                }),
            ).toThrow();
        });

        it('rejects a negative amount', () => {
            expect(() =>
                LedgerEntry.create({
                    ...validProps(),
                    amount: Money.create('-10.00', 'BRL'),
                }),
            ).toThrow();
        });

        it('rejects different currencies between amount and balance', () => {
            expect(() =>
                LedgerEntry.create({
                    ...validProps(),
                    balanceAfter: Money.create('90.00', 'USD'),
                }),
            ).toThrow();
        });

        it('rejects an invalid creation date', () => {
            expect(() =>
                LedgerEntry.create({
                    ...validProps(),
                    createdAt: 'invalid-date',
                }),
            ).toThrow();
        });

        it('creates an immutable ledger entry', () => {
            const entry = LedgerEntry.create(validProps());

            expect(Object.isFrozen(entry)).toBe(true);
        });

        it('accepts a balanced debit entry', () => {
            const entry = LedgerEntry.create(validProps());

            expect(entry.isBalanced()).toBe(true);
        });

        it('rejects an unbalanced debit entry', () => {
            expect(() =>
                LedgerEntry.create({
                    ...validProps(),
                    balanceAfter: Money.create('95.00', 'BRL'),
                }),
            ).toThrow();
        });

        it('accepts a balanced credit entry', () => {
            const entry = LedgerEntry.create({
                ...validProps(),
                direction: LedgerEntryDirection.CREDIT,
                balanceBefore: Money.create('100.00', 'BRL'),
                balanceAfter: Money.create('110.00', 'BRL'),
            });

            expect(entry.isBalanced()).toBe(true);
        });

        it('rejects an unbalanced credit entry', () => {
            expect(() =>
                LedgerEntry.create({
                    ...validProps(),
                    direction: LedgerEntryDirection.CREDIT,
                    balanceBefore: Money.create('100.00', 'BRL'),
                    balanceAfter: Money.create('115.00', 'BRL'),
                }),
            ).toThrow();
        });
    });

    describe('rehydrate', () => {
        it('rehydrates a valid ledger entry', () => {
            const entry = LedgerEntry.rehydrate(validProps());

            expect(entry).toBeInstanceOf(LedgerEntry);
            expect(entry.id).toBe('ledger-1');
            expect(entry.amount.toString()).toBe('10.00');
        });

        it('rejects invalid data during rehydration', () => {
            expect(() =>
                LedgerEntry.rehydrate({
                    ...validProps(),
                    amount: Money.zero('BRL'),
                }),
            ).toThrow();
        });
    });
});
