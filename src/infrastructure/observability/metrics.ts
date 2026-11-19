/**
 * Registro de métricas mínimo, sem dependências, com exposição em texto
 * Prometheus (`GET /metrics`).
 *
 * Decisão: uma implementação própria de ~150 linhas em vez de `prom-client`
 * mantém o domínio e a aplicação livres de dependências extras e deixa o
 * comportamento 100% testável em `bun test`. Trocar por prom-client/OpenTelemetry
 * depois é uma mudança local a este arquivo (a API `metrics.*` é o contrato).
 */
export type Labels = Record<string, string>;

const DEFAULT_BUCKETS_SECONDS = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

function labelKey(labels: Labels): string {
    return Object.keys(labels)
        .sort()
        .map((key) => `${key}=${labels[key]}`)
        .join('\u0000');
}

function escapeLabelValue(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/"/g, '\\"');
}

function formatLabels(labels: Labels): string {
    const keys = Object.keys(labels).sort();
    if (keys.length === 0) return '';
    return `{${keys.map((key) => `${key}="${escapeLabelValue(labels[key]!)}"`).join(',')}}`;
}

abstract class Metric {
    constructor(
        public readonly name: string,
        public readonly help: string,
    ) {}

    abstract readonly type: 'counter' | 'gauge' | 'histogram';
    abstract render(): string[];
    abstract reset(): void;

    protected header(): string[] {
        return [
            `# HELP ${this.name} ${this.help}`,
            `# TYPE ${this.name} ${this.type}`,
        ];
    }
}

export class Counter extends Metric {
    readonly type = 'counter' as const;
    private readonly values = new Map<string, { labels: Labels; value: number }>();

    inc(labels: Labels = {}, amount = 1): void {
        if (!Number.isFinite(amount) || amount < 0) {
            throw new Error('Counter increments must be finite and non-negative.');
        }
        const key = labelKey(labels);
        const current = this.values.get(key);
        if (current) current.value += amount;
        else this.values.set(key, { labels: { ...labels }, value: amount });
    }

    get(labels: Labels = {}): number {
        return this.values.get(labelKey(labels))?.value ?? 0;
    }

    /** Soma de todas as séries (útil em testes). */
    total(): number {
        let sum = 0;
        for (const entry of this.values.values()) sum += entry.value;
        return sum;
    }

    render(): string[] {
        const lines = this.header();
        for (const { labels, value } of this.values.values()) {
            lines.push(`${this.name}${formatLabels(labels)} ${value}`);
        }
        return lines;
    }

    reset(): void {
        this.values.clear();
    }
}

export class Gauge extends Metric {
    readonly type = 'gauge' as const;
    private readonly values = new Map<string, { labels: Labels; value: number }>();

    set(value: number, labels: Labels = {}): void {
        this.values.set(labelKey(labels), { labels: { ...labels }, value });
    }

    get(labels: Labels = {}): number {
        return this.values.get(labelKey(labels))?.value ?? 0;
    }

    render(): string[] {
        const lines = this.header();
        for (const { labels, value } of this.values.values()) {
            lines.push(`${this.name}${formatLabels(labels)} ${value}`);
        }
        return lines;
    }

    reset(): void {
        this.values.clear();
    }
}

export class Histogram extends Metric {
    readonly type = 'histogram' as const;
    private readonly series = new Map<
        string,
        { labels: Labels; counts: number[]; sum: number; count: number }
    >();

    constructor(
        name: string,
        help: string,
        private readonly buckets: readonly number[] = DEFAULT_BUCKETS_SECONDS,
    ) {
        super(name, help);
    }

    observe(value: number, labels: Labels = {}): void {
        if (!Number.isFinite(value) || value < 0) return;
        const key = labelKey(labels);
        let entry = this.series.get(key);
        if (!entry) {
            entry = {
                labels: { ...labels },
                counts: Array.from({ length: this.buckets.length }, () => 0),
                sum: 0,
                count: 0,
            };
            this.series.set(key, entry);
        }
        this.buckets.forEach((upperBound, index) => {
            if (value <= upperBound) entry!.counts[index]!++;
        });
        entry.sum += value;
        entry.count += 1;
    }

    count(labels: Labels = {}): number {
        return this.series.get(labelKey(labels))?.count ?? 0;
    }

    render(): string[] {
        const lines = this.header();
        for (const { labels, counts, sum, count } of this.series.values()) {
            this.buckets.forEach((upperBound, index) => {
                lines.push(
                    `${this.name}_bucket${formatLabels({ ...labels, le: String(upperBound) })} ${counts[index]}`,
                );
            });
            lines.push(
                `${this.name}_bucket${formatLabels({ ...labels, le: '+Inf' })} ${count}`,
            );
            lines.push(`${this.name}_sum${formatLabels(labels)} ${sum}`);
            lines.push(`${this.name}_count${formatLabels(labels)} ${count}`);
        }
        return lines;
    }

    reset(): void {
        this.series.clear();
    }
}

export type Collector = () => Promise<void> | void;

export class MetricsRegistry {
    private readonly all: Metric[] = [];
    private readonly collectors: Collector[] = [];

    counter(name: string, help: string): Counter {
        return this.register(new Counter(name, help));
    }

    gauge(name: string, help: string): Gauge {
        return this.register(new Gauge(name, help));
    }

    histogram(
        name: string,
        help: string,
        buckets?: readonly number[],
    ): Histogram {
        return this.register(new Histogram(name, help, buckets));
    }

    /** Coletores atualizam gauges calculados sob demanda (ex.: outbox lag). */
    addCollector(collector: Collector): void {
        this.collectors.push(collector);
    }

    async render(): Promise<string> {
        for (const collector of this.collectors) {
            try {
                await collector();
            } catch {
                // Uma coleta com falha não pode derrubar o scrape inteiro.
            }
        }
        return `${this.all.flatMap((metric) => metric.render()).join('\n')}\n`;
    }

    reset(): void {
        for (const metric of this.all) metric.reset();
    }

    private register<T extends Metric>(metric: T): T {
        this.all.push(metric);
        return metric;
    }
}

export const registry = new MetricsRegistry();

/**
 * Catálogo de métricas do serviço. Cobre os itens exigidos pelo enunciado:
 * transações por status, duplicatas, retries, DLQ, conflitos de lock,
 * outbox lag e latência de processamento.
 */
export const metrics = {
    transactionsTotal: registry.counter(
        'wager_transactions_total',
        'Transações processadas por status final, tipo e canal de entrada.',
    ),
    duplicatesTotal: registry.counter(
        'wager_duplicates_total',
        'Requisições idempotentes repetidas (replays) detectadas.',
    ),
    idempotencyConflictsTotal: registry.counter(
        'wager_idempotency_conflicts_total',
        'Reuso de idempotency key / external id com payload diferente.',
    ),
    processingDurationSeconds: registry.histogram(
        'wager_processing_duration_seconds',
        'Latência do caso de uso de processamento (inclui espera por lock).',
    ),
    walletLockWaitSeconds: registry.histogram(
        'wallet_lock_wait_seconds',
        'Tempo esperando o lock pessimista da wallet (SELECT ... FOR UPDATE).',
    ),
    lockConflictsTotal: registry.counter(
        'db_lock_conflicts_total',
        'Conflitos de concorrência no banco: deadlock, lock timeout, serialização, corrida de unique.',
    ),
    retriesTotal: registry.counter(
        'retries_total',
        'Retentativas por origem (sqs_inbound, outbox_publish, reference_retry).',
    ),
    dlqMessagesTotal: registry.counter(
        'dlq_messages_total',
        'Mensagens enviadas à DLQ por fila e motivo.',
    ),
    inboxMessagesTotal: registry.counter(
        'inbox_messages_total',
        'Mensagens SQS consumidas por resultado (processed, duplicate, business_rejected, transient_error, dead_lettered).',
    ),
    outboxPublishedTotal: registry.counter(
        'outbox_published_total',
        'Eventos de outbox publicados com sucesso.',
    ),
    outboxPublishFailuresTotal: registry.counter(
        'outbox_publish_failures_total',
        'Falhas de publicação de eventos de outbox, por terminalidade.',
    ),
    outboxPending: registry.gauge(
        'outbox_pending_events',
        'Eventos de outbox aguardando publicação.',
    ),
    outboxFailed: registry.gauge(
        'outbox_failed_events',
        'Eventos de outbox esgotados (FAILED) aguardando intervenção operacional.',
    ),
    outboxLagSeconds: registry.gauge(
        'outbox_lag_seconds',
        'Idade do evento pendente mais antigo no outbox.',
    ),
    reconciliationMismatchTotal: registry.counter(
        'reconciliation_mismatch_total',
        'Divergências entre saldo materializado e ledger encontradas na reconciliação.',
    ),
    httpRequestsTotal: registry.counter(
        'http_requests_total',
        'Requisições HTTP por método, rota-template e status.',
    ),
};

const LOCK_ERROR_CODES: Readonly<Record<string, string>> = {
    '40P01': 'deadlock',
    '55P03': 'lock_timeout',
    '40001': 'serialization_failure',
    '23505': 'unique_violation_race',
};

/** Extrai o SQLSTATE de um erro do driver, percorrendo `cause`/`driverException`. */
export function postgresErrorCode(error: unknown): string | undefined {
    let current: unknown = error;
    for (let depth = 0; depth < 5; depth++) {
        if (typeof current !== 'object' || current === null) return undefined;
        const candidate = current as {
            code?: unknown;
            cause?: unknown;
            driverException?: unknown;
            original?: unknown;
        };
        if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
            return candidate.code;
        }
        current = candidate.cause ?? candidate.driverException ?? candidate.original;
    }
    return undefined;
}

/** Conta o erro como conflito de lock/concorrência, se for um. Retorna o tipo. */
export function recordLockConflict(error: unknown): string | undefined {
    const code = postgresErrorCode(error);
    const kind = code ? LOCK_ERROR_CODES[code] : undefined;
    if (kind) metrics.lockConflictsTotal.inc({ kind });
    return kind;
}
