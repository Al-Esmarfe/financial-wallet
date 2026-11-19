import { Migration } from '@mikro-orm/migrations';

export class Migration20261119173000 extends Migration {
    override async up(): Promise<void> {
        // A Wallet aggregate emits many WalletBalanceChanged events over time.
        // A unique (aggregate, event type) index would incorrectly reject them.
        this.addSql('DROP INDEX IF EXISTS uq_outbox_aggregate_event;');
        this.addSql(`
            CREATE INDEX idx_outbox_aggregate_stream
            ON outbox_events (aggregate_type, aggregate_id, occurred_at, id);
        `);
    }

    override async down(): Promise<void> {
        this.addSql('DROP INDEX IF EXISTS idx_outbox_aggregate_stream;');
        // O índice único antigo era um bug: uma wallet emite vários WalletBalanceChanged.
        // Com dados reais ele não pode ser recriado sem apagar eventos — e eventos do
        // outbox nunca são apagados. Recria-o só se os dados permitirem; caso contrário
        // o down segue (a migration anterior faz DROP INDEX IF EXISTS) e avisa.
        this.addSql(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM outbox_events
                    GROUP BY aggregate_type, aggregate_id, event_type
                    HAVING COUNT(*) > 1
                ) THEN
                    RAISE NOTICE 'uq_outbox_aggregate_event not recreated: outbox already holds several events per aggregate/type';
                ELSE
                    CREATE UNIQUE INDEX uq_outbox_aggregate_event
                    ON outbox_events (aggregate_type, aggregate_id, event_type);
                END IF;
            END $$;
        `);
    }
}
