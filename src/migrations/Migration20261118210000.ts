import { Migration } from '@mikro-orm/migrations';

export class Migration20261118210000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`
            ALTER TABLE wager_transactions
            ADD COLUMN reference_attempts INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN next_reference_attempt_at TIMESTAMPTZ NULL,
            ADD COLUMN reference_expires_at TIMESTAMPTZ NULL;
        `);

        this.addSql(`
            ALTER TABLE wager_transactions
            ADD CONSTRAINT ck_wager_reference_attempts_non_negative
            CHECK (reference_attempts >= 0);
        `);

        // Agenda a primeira tentativa das pendências já existentes
        // e preserva o prazo de expiração contado desde sua criação.
        this.addSql(`
            UPDATE wager_transactions
            SET
                next_reference_attempt_at = created_at + INTERVAL '5 seconds',
                reference_expires_at = created_at + INTERVAL '24 hours'
            WHERE status = 'PENDING_REFERENCE';
        `);

        this.addSql(`
            DROP INDEX IF EXISTS idx_wager_pending_reference;
        `);

        this.addSql(`
            CREATE INDEX idx_wager_pending_reference_due
            ON wager_transactions (
                next_reference_attempt_at,
                created_at,
                id
            )
            WHERE status = 'PENDING_REFERENCE'
              AND next_reference_attempt_at IS NOT NULL;
        `);
    }

    override async down(): Promise<void> {
        this.addSql(`
            DROP INDEX IF EXISTS idx_wager_pending_reference_due;
        `);

        this.addSql(`
            ALTER TABLE wager_transactions
            DROP CONSTRAINT IF EXISTS ck_wager_reference_attempts_non_negative;
        `);

        this.addSql(`
            ALTER TABLE wager_transactions
            DROP COLUMN IF EXISTS reference_attempts,
            DROP COLUMN IF EXISTS next_reference_attempt_at,
            DROP COLUMN IF EXISTS reference_expires_at;
        `);

        this.addSql(`
            CREATE INDEX idx_wager_pending_reference
            ON wager_transactions (created_at)
            WHERE status = 'PENDING_REFERENCE';
        `);
    }
}
