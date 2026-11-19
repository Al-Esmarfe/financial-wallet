
import {
  Entity,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'varchar', length: 128 })
  playerId!: string;

  @Property({ type: 'char', length: 3 })
  currency!: string;

  // PostgreSQL NUMERIC: nunca converter para number.
  @Property({ type: 'decimal', columnType: 'numeric(20,2)' })
  balance!: string;

  @Property({ type: 'integer', default: 0 })
  version!: number;

  @Property({ columnType: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date();

  @Property({ columnType: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
