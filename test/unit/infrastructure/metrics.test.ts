import { beforeEach, describe, expect, it } from 'bun:test';
import {
    Counter,
    Histogram,
    MetricsRegistry,
    metrics,
    postgresErrorCode,
    recordLockConflict,
    registry,
} from '../../../src/infrastructure/observability/metrics.js';

describe('metrics registry', () => {
    it('renders counters with sorted, escaped labels in Prometheus text format', async () => {
        const local = new MetricsRegistry();
        const counter = local.counter('things_total', 'Things.');
        counter.inc({ status: 'OK', kind: 'a"b' });
        counter.inc({ kind: 'a"b', status: 'OK' }, 2); // mesma série, ordem de labels diferente

        const text = await local.render();

        expect(text).toContain('# HELP things_total Things.');
        expect(text).toContain('# TYPE things_total counter');
        expect(text).toContain('things_total{kind="a\\"b",status="OK"} 3');
    });

    it('rejects negative counter increments', () => {
        expect(() => new Counter('x', 'x').inc({}, -1)).toThrow();
    });

    it('renders cumulative histogram buckets, sum and count', async () => {
        const local = new MetricsRegistry();
        const histogram: Histogram = local.histogram('latency_seconds', 'Latency.', [0.1, 1]);
        histogram.observe(0.05);
        histogram.observe(0.5);
        histogram.observe(5);

        const text = await local.render();

        expect(text).toContain('latency_seconds_bucket{le="0.1"} 1');
        expect(text).toContain('latency_seconds_bucket{le="1"} 2');
        expect(text).toContain('latency_seconds_bucket{le="+Inf"} 3');
        expect(text).toContain('latency_seconds_count 3');
        expect(text).toContain('latency_seconds_sum 5.55');
    });

    it('runs collectors at scrape time and survives a failing collector', async () => {
        const local = new MetricsRegistry();
        const gauge = local.gauge('backlog', 'Backlog.');
        local.addCollector(() => { throw new Error('db down'); });
        local.addCollector(() => gauge.set(7));

        expect(await local.render()).toContain('backlog 7');
    });

    it('exposes every metric required by the challenge', async () => {
        const text = await registry.render();
        for (const name of [
            'wager_transactions_total', // transações por status
            'wager_duplicates_total', // duplicatas detectadas
            'retries_total', // retries
            'dlq_messages_total', // mensagens em DLQ
            'db_lock_conflicts_total', // conflitos de lock
            'outbox_lag_seconds', // outbox lag
            'wager_processing_duration_seconds', // latência de processamento
        ]) {
            expect(text).toContain(`# TYPE ${name} `);
        }
    });
});

describe('lock conflict detection', () => {
    beforeEach(() => metrics.lockConflictsTotal.reset());

    it.each([
        ['40P01', 'deadlock'],
        ['55P03', 'lock_timeout'],
        ['40001', 'serialization_failure'],
    ])('classifies SQLSTATE %s as %s, even when nested in cause/driverException', (code, kind) => {
        const wrapped = Object.assign(new Error('wrapper'), { cause: { driverException: { code } } });

        expect(postgresErrorCode(wrapped)).toBe(code);
        expect(recordLockConflict(wrapped)).toBe(kind);
        expect(metrics.lockConflictsTotal.get({ kind })).toBe(1);
    });

    it('ignores unrelated errors', () => {
        expect(recordLockConflict(new Error('nope'))).toBeUndefined();
        expect(recordLockConflict('string')).toBeUndefined();
        expect(metrics.lockConflictsTotal.total()).toBe(0);
    });
});
