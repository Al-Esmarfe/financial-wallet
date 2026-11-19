import { EntityManager } from '@mikro-orm/postgresql';

import type { OutboxEventRepository } from '../../../application/ports/outbox-event.repository.js';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message.js';
import { OutboxEventEntity } from '../entities/outbox-event.entity.js';

export class MikroOrmOutboxEventRepository implements OutboxEventRepository {
    constructor(private readonly em: EntityManager) {}

    async enqueue(message: OutboxMessage): Promise<void> {
        const entity = this.em.create(OutboxEventEntity, {
            id: message.id,
            aggregateType: message.aggregateType,
            aggregateId: message.aggregateId,
            eventType: message.eventType,
            payload: { ...message.payload },
            occurredAt: message.occurredAt,
            status: message.status,
            attempts: message.attempts,
        });
        this.em.persist(entity);
    }
}
