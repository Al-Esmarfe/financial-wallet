import { Migration } from '@mikro-orm/migrations';

export class Migration20261118181000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`
            ALTER TABLE "wager_transactions"
            ADD COLUMN "game_id" VARCHAR(150);
        `);

        this.addSql(`
            UPDATE "wager_transactions"
            SET "game_id" = CASE
                WHEN "type" = 'OPENING' THEN 'INTERNAL'
                ELSE 'UNKNOWN'
            END
            WHERE "game_id" IS NULL;
        `);

        this.addSql(`
            ALTER TABLE "wager_transactions"
            ALTER COLUMN "game_id" SET NOT NULL;
        `);

        this.addSql(`
            ALTER TABLE "wager_transactions"
            ADD COLUMN "reference_external_transaction_id" VARCHAR(150),
            ADD COLUMN "failure_code" VARCHAR(50),
            ADD COLUMN "processed_at" TIMESTAMPTZ;
        `);
    }

    override async down(): Promise<void> {
        this.addSql(`
            ALTER TABLE "wager_transactions"
            DROP COLUMN "processed_at",
            DROP COLUMN "failure_code",
            DROP COLUMN "reference_external_transaction_id",
            DROP COLUMN "game_id";
        `);
    }
}
