import { Migration } from '@mikro-orm/migrations';

export class Migration20261119160000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_aggregate_event
                ON outbox_events (aggregate_type, aggregate_id, event_type);
        `);
        this.addSql(`
            CREATE INDEX IF NOT EXISTS idx_outbox_processing_lease
                ON outbox_events (locked_at)
                WHERE status = 'PROCESSING';
        `);
        this.addSql(`
            CREATE INDEX IF NOT EXISTS idx_inbox_consumer_status
                ON inbox_messages (consumer_name, status, received_at);
        `);
    }

    override async down(): Promise<void> {
        this.addSql('DROP INDEX IF EXISTS idx_inbox_consumer_status;');
        this.addSql('DROP INDEX IF EXISTS idx_outbox_processing_lease;');
        this.addSql('DROP INDEX IF EXISTS uq_outbox_aggregate_event;');
    }
}
