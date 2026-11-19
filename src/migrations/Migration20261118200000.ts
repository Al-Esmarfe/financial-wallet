import { Migration } from '@mikro-orm/migrations';

export class Migration20261118200000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`
            DROP INDEX IF EXISTS uq_refund_reference_transaction;
        `);

        this.addSql(`
            CREATE UNIQUE INDEX uq_wager_transaction_reference_reversal
            ON wager_transactions (reference_transaction_id)
            WHERE type IN ('REFUND', 'ROLLBACK')
              AND reference_transaction_id IS NOT NULL;
        `);
    }

    override async down(): Promise<void> {
        this.addSql(`
            DROP INDEX IF EXISTS uq_wager_transaction_reference_reversal;
        `);

        this.addSql(`
            CREATE UNIQUE INDEX uq_refund_reference_transaction
            ON wager_transactions (reference_transaction_id)
            WHERE type = 'REFUND'
              AND reference_transaction_id IS NOT NULL;
        `);
    }
}
