import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wager_transactions' })
export class WagerTransactionEntity {
    @PrimaryKey({ type: 'uuid' })
    id!: string;

    @Property({ type: 'varchar', length: 100 })
    providerId!: string;

    @Property({ type: 'varchar', length: 150 })
    providerTransactionId!: string;

    @Property({ type: 'varchar', length: 128 })
    playerId!: string;

    @Property({ type: 'uuid' })
    walletId!: string;

    @Property({ type: 'varchar', length: 150 })
    roundId!: string;

    @Property({ type: 'varchar', length: 150 })
    gameId!: string;

    @Property({ type: 'varchar', length: 30 })
    type!: string;

    @Property({ type: 'varchar', length: 30 })
    status!: string;

    @Property({ type: 'decimal', columnType: 'numeric(20,2)' })
    amount!: string;

    @Property({ type: 'decimal', columnType: 'numeric(20,2)', nullable: true })
    responseBalance?: string | null;

    @Property({ type: 'char', length: 3 })
    currency!: string;

    @Property({ type: 'uuid', nullable: true })
    referenceTransactionId?: string;

    @Property({ type: 'varchar', length: 150, nullable: true })
    referenceExternalTransactionId?: string;

    @Property({ type: 'varchar', length: 150 })
    idempotencyKey!: string;

    @Property({ type: 'varchar', length: 64 })
    requestHash!: string;

    @Property({ type: 'text', nullable: true })
    rejectionReason?: string;

    @Property({ type: 'text', nullable: true })
    failureReason?: string;

    @Property({ type: 'varchar', length: 50, nullable: true })
    failureCode?: string;

    @Property({ type: 'timestamptz', nullable: true })
    processedAt?: Date;

    @Property({ type: 'timestamptz' })
    createdAt!: Date;

    @Property({ type: 'timestamptz', onUpdate: () => new Date() })
    updatedAt!: Date;

    @Property({ type: 'integer', default: 0 })
    referenceAttempts = 0;

    @Property({ type: 'timestamptz', nullable: true })
    nextReferenceAttemptAt?: Date;

    @Property({ type: 'timestamptz', nullable: true })
    referenceExpiresAt?: Date;
}
