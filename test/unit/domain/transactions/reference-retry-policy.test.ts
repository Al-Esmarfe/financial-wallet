import { describe, expect, it } from 'bun:test';
import { ReferenceRetryPolicy } from '../../../../src/domain/transactions/reference-retry-policy.js';

describe('ReferenceRetryPolicy', () => {
    const policy = new ReferenceRetryPolicy();

    const baseDate = new Date('2026-11-18T12:00:00.000Z');

    describe('getDelayMs', () => {
        it('returns the initial delay for zero completed attempts', () => {
            expect(policy.getDelayMs(0)).toBe(5_000);
        });

        it('calculates exponential backoff', () => {
            expect(policy.getDelayMs(1)).toBe(10_000);
            expect(policy.getDelayMs(2)).toBe(20_000);
            expect(policy.getDelayMs(3)).toBe(40_000);
        });

        it('does not exceed the maximum delay of 15 minutes', () => {
            expect(policy.getDelayMs(20)).toBe(15 * 60 * 1_000);
        });

        it('rejects negative or non-integer attempt counts', () => {
            expect(() => policy.getDelayMs(-1)).toThrow();
            expect(() => policy.getDelayMs(1.5)).toThrow();
        });
    });

    describe('getNextAttemptAt', () => {
        it('calculates the next attempt date', () => {
            const nextAttempt = policy.getNextAttemptAt(0, baseDate);

            expect(nextAttempt.toISOString()).toBe('2026-11-18T12:00:05.000Z');
        });

        it('does not mutate the supplied date', () => {
            const originalTime = baseDate.getTime();

            policy.getNextAttemptAt(2, baseDate);

            expect(baseDate.getTime()).toBe(originalTime);
        });

        it('rejects an invalid date', () => {
            expect(() =>
                policy.getNextAttemptAt(0, new Date('invalid')),
            ).toThrow('Invalid date.');
        });
    });

    describe('expiration', () => {
        it('calculates expiration after 24 hours', () => {
            const expiration = policy.getExpirationAt(baseDate);

            expect(expiration.toISOString()).toBe('2026-11-19T12:00:00.000Z');
        });

        it('does not consider the transaction expired before 24 hours', () => {
            const beforeExpiration = new Date(
                baseDate.getTime() + 24 * 60 * 60 * 1_000 - 1,
            );

            expect(policy.isExpired(baseDate, beforeExpiration)).toBe(false);
        });

        it('considers the transaction expired exactly at 24 hours', () => {
            const expiration = policy.getExpirationAt(baseDate);

            expect(policy.isExpired(baseDate, expiration)).toBe(true);
        });
    });

    describe('configuration', () => {
        it('allows custom configuration', () => {
            const customPolicy = new ReferenceRetryPolicy({
                initialDelayMs: 1_000,
                multiplier: 3,
                maxDelayMs: 10_000,
                expirationMs: 60_000,
            });

            expect(customPolicy.getDelayMs(0)).toBe(1_000);
            expect(customPolicy.getDelayMs(1)).toBe(3_000);
            expect(customPolicy.getDelayMs(2)).toBe(9_000);
            expect(customPolicy.getDelayMs(3)).toBe(10_000);
        });

        it('rejects invalid configuration', () => {
            expect(
                () => new ReferenceRetryPolicy({ initialDelayMs: 0 }),
            ).toThrow();

            expect(() => new ReferenceRetryPolicy({ multiplier: 1 })).toThrow();

            expect(
                () => new ReferenceRetryPolicy({ maxDelayMs: 1_000 }),
            ).toThrow();

            expect(
                () => new ReferenceRetryPolicy({ expirationMs: 0 }),
            ).toThrow();
        });
    });
});
