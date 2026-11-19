
import {
  Entity,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'outbox_events' })
export class OutboxEventEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'varchar', length: 100 })
  aggregateType!: string;

  @Property({ type: 'uuid' })
  aggregateId!: string;

  @Property({ type: 'varchar', length: 100 })
  eventType!: string;

  @Property({ type: 'json', columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ type: 'varchar', length: 30 })
  status!: string;

  @Property({ type: 'integer', default: 0 })
  attempts!: number;

  @Property({ type: 'timestamptz' })
  occurredAt!: Date;

  @Property({ type: 'timestamptz', nullable: true })
  publishedAt?: Date;

  @Property({ type: 'timestamptz', nullable: true })
  lockedAt?: Date;

  /** Próxima tentativa de publicação (backoff exponencial); null = elegível imediatamente. */
  @Property({ type: 'timestamptz', nullable: true })
  nextAttemptAt?: Date;

  @Property({ type: 'text', nullable: true })
  lastError?: string;
}
