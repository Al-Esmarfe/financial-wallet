import { InvariantViolationError } from '../errors/domain-errors.js';
import { exponentialBackoffMs } from './backoff.js';

/**
 * Estados de uma linha do outbox.
 *
 *   PENDING ──claim──► PROCESSING ──envio ok──► PUBLISHED (terminal)
 *      ▲                   │
 *      └──scheduleRetry────┤ (falha, attempts < maxAttempts)
 *                          ▼
 *                       FAILED  (attempts ≥ maxAttempts: "estacionado")
 *
 * FAILED NÃO é abandono: o evento já foi confirmado junto com a transação
 * financeira e não pode ser perdido. Ele continua elegível, mas só a cada
 * `capMs` (retentativa lenta), e a métrica `outbox_failed` dispara o alerta.
 */
export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED';

/** Envelope serializável mínimo de um evento de integração. */
export interface OutboxEventEnvelope {
    readonly eventId: string;
    readonly eventType: string;
    readonly aggregateId: string;
    readonly occurredAt: Date;
    toJSON(): unknown;
}

export interface OutboxRetryPolicy {
    maxAttempts: number;
    baseMs: number;
    capMs: number;
    /** Injetável para testes determinísticos. */
    random?: () => number;
}

export interface OutboxMessageState {
    id: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: Record<string, unknown>;
    occurredAt: Date;
    status: OutboxStatus;
    attempts: number;
    nextAttemptAt?: Date | null;
    publishedAt?: Date | null;
    lastError?: string | null;
}

export class OutboxMessage {
    private constructor(
        public readonly id: string,
        public readonly aggregateType: string,
        public readonly aggregateId: string,
        public readonly eventType: string,
        public readonly payload: Readonly<Record<string, unknown>>,
        public readonly occurredAt: Date,
        private _status: OutboxStatus,
        private _attempts: number,
        private _nextAttemptAt?: Date,
        private _publishedAt?: Date,
        private _lastError?: string,
    ) {}

    /** Cria a linha do outbox a partir do evento; o payload é o envelope versionado (JSON estável). */
    static enqueue(event: OutboxEventEnvelope, aggregateType: string): OutboxMessage {
        if (!event.eventId.trim() || !event.aggregateId.trim() || !event.eventType.trim()) {
            throw new InvariantViolationError('Outbox event identifiers are required.');
        }
        if (!aggregateType.trim()) {
            throw new InvariantViolationError('Outbox aggregate type is required.');
        }
        // Round-trip JSON: congela exatamente o que será publicado (sem instâncias de Money/Date).
        const payload = JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>;
        return new OutboxMessage(
            event.eventId,
            aggregateType,
            event.aggregateId,
            event.eventType,
            Object.freeze(payload),
            new Date(event.occurredAt),
            'PENDING',
            0,
        );
    }

    /** Reconstrução a partir da persistência — não revalida transições. */
    static rehydrate(state: OutboxMessageState): OutboxMessage {
        return new OutboxMessage(
            state.id,
            state.aggregateType,
            state.aggregateId,
            state.eventType,
            Object.freeze({ ...state.payload }),
            new Date(state.occurredAt),
            state.status,
            state.attempts,
            state.nextAttemptAt ? new Date(state.nextAttemptAt) : undefined,
            state.publishedAt ? new Date(state.publishedAt) : undefined,
            state.lastError ?? undefined,
        );
    }

    get status(): OutboxStatus {
        return this._status;
    }

    get attempts(): number {
        return this._attempts;
    }

    get nextAttemptAt(): Date | undefined {
        return this._nextAttemptAt ? new Date(this._nextAttemptAt) : undefined;
    }

    get publishedAt(): Date | undefined {
        return this._publishedAt ? new Date(this._publishedAt) : undefined;
    }

    get lastError(): string | undefined {
        return this._lastError;
    }

    isPending(): boolean {
        return this._status !== 'PUBLISHED';
    }

    /** Elegível para publicação agora (PENDING ou FAILED estacionado cujo prazo venceu). */
    isDue(now: Date): boolean {
        if (this._status !== 'PENDING' && this._status !== 'FAILED') return false;
        return !this._nextAttemptAt || this._nextAttemptAt.getTime() <= now.getTime();
    }

    /** Esgotou as tentativas "rápidas" e está em retentativa lenta (alerta operacional). */
    isParked(): boolean {
        return this._status === 'FAILED';
    }

    markPublished(at: Date): void {
        if (this._status === 'PUBLISHED') {
            throw new InvariantViolationError(`Outbox event ${this.id} is already published.`);
        }
        this._status = 'PUBLISHED';
        this._publishedAt = new Date(at);
        this._nextAttemptAt = undefined;
        this._lastError = undefined;
    }

    /**
     * Registra uma tentativa de publicação que falhou: incrementa `attempts` e
     * calcula `nextAttemptAt` com backoff exponencial. Ao atingir `maxAttempts`
     * vira FAILED (estacionado) e passa a tentar a cada `capMs` — nunca é descartado.
     */
    scheduleRetry(now: Date, policy: OutboxRetryPolicy, error?: string): void {
        if (this._status === 'PUBLISHED') {
            throw new InvariantViolationError(`Outbox event ${this.id} is already published.`);
        }
        this._attempts += 1;
        const parked = this._attempts >= policy.maxAttempts;
        const delayMs = parked
            ? policy.capMs
            : exponentialBackoffMs(this._attempts, {
                  baseMs: policy.baseMs,
                  capMs: policy.capMs,
                  random: policy.random,
              });
        this._status = parked ? 'FAILED' : 'PENDING';
        this._nextAttemptAt = new Date(now.getTime() + delayMs);
        this._lastError = error?.slice(0, 4000);
    }
}
