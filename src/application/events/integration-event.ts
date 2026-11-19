export interface IntegrationEventProps<T> {
    eventId: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: Date;
    data: T;
}

export abstract class IntegrationEvent<T> {
    abstract readonly eventType: string;
    abstract readonly version: number;

    readonly eventId: string;
    readonly aggregateId: string;
    readonly correlationId: string;
    readonly causationId?: string;
    readonly occurredAt: Date;
    readonly data: Readonly<T>;

    protected constructor(props: IntegrationEventProps<T>) {
        if (!props.eventId.trim() || !props.aggregateId.trim() || !props.correlationId.trim()) {
            throw new Error('Integration event identifiers must be non-empty.');
        }
        if (Number.isNaN(props.occurredAt.getTime())) {
            throw new Error('Integration event occurredAt must be a valid date.');
        }

        this.eventId = props.eventId;
        this.aggregateId = props.aggregateId;
        this.correlationId = props.correlationId;
        this.causationId = props.causationId;
        this.occurredAt = new Date(props.occurredAt);
        this.data = Object.freeze({ ...props.data });
    }

    toJSON(): {
        eventId: string;
        eventType: string;
        aggregateId: string;
        correlationId: string;
        causationId?: string;
        occurredAt: string;
        version: number;
        data: Readonly<T>;
    } {
        return {
            eventId: this.eventId,
            eventType: this.eventType,
            aggregateId: this.aggregateId,
            correlationId: this.correlationId,
            ...(this.causationId ? { causationId: this.causationId } : {}),
            occurredAt: this.occurredAt.toISOString(),
            version: this.version,
            data: this.data,
        };
    }
}
