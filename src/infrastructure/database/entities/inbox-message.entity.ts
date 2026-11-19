
import {
  Entity,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'varchar', length: 100 })
  consumerName!: string;

  @Property({ type: 'varchar', length: 200 })
  messageId!: string;

  @Property({ type: 'varchar', length: 200, nullable: true })
  messageGroupId?: string;

  /** sha256 do JSON canônico dos campos de negócio; detecta messageId reaproveitado com payload diferente. */
  @Property({ type: 'varchar', length: 64, nullable: true })
  payloadHash?: string;

  @Property({ type: 'json', columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ type: 'varchar', length: 30 })
  status!: string;

  @Property({ type: 'integer', default: 0 })
  attempts!: number;

  @Property({ type: 'timestamptz' })
  receivedAt!: Date;

  @Property({ type: 'timestamptz', nullable: true })
  processedAt?: Date;

  @Property({ type: 'text', nullable: true })
  lastError?: string;
}
