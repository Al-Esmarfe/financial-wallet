import { Migration } from '@mikro-orm/migrations';

export class Migration20261118183000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`
            ALTER TABLE "wager_transactions"
            ADD COLUMN "response_balance" NUMERIC(20,2) NULL;
        `);
    }

    override async down(): Promise<void> {
        this.addSql(`
            ALTER TABLE "wager_transactions"
            DROP COLUMN "response_balance";
        `);
    }
}
