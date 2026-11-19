import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'ledger_entries' })
export class LedgerEntryEntity {
    @PrimaryKey({ type: 'uuid' })
    id!: string;

    @Property({ type: 'uuid' })
    walletId!: string;

    @Property({ type: 'uuid' })
    transactionId!: string;

    @Property({ type: 'varchar', length: 10 })
    direction!: string;

    @Property({ type: 'varchar', length: 30 })
    transactionType!: string;

    @Property({ type: 'decimal', columnType: 'numeric(20,2)' })
    amount!: string;

    @Property({ type: 'char', length: 3 })
    currency!: string;

    @Property({ type: 'decimal', columnType: 'numeric(20,2)' })
    balanceBefore!: string;

    @Property({ type: 'decimal', columnType: 'numeric(20,2)' })
    balanceAfter!: string;

    /** Sequência por wallet (= wallet.version após o lançamento); UNIQUE (wallet_id, wallet_version). */
    @Property({ type: 'integer' })
    walletVersion!: number;

    @Property({ type: 'timestamptz' })
    createdAt!: Date;
}
