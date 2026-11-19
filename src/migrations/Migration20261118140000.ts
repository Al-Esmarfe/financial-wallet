import { Migration } from '@mikro-orm/migrations';

export class Migration20261118140000 extends Migration {
    override async up(): Promise<void> {
        // Adiciona a coluna permitindo NULL temporariamente.
        this.addSql(`
            ALTER TABLE ledger_entries
            ADD COLUMN balance_before NUMERIC(20, 2);
        `);

        // Reconstrói o saldo anterior dos lançamentos existentes.
        this.addSql(`
            UPDATE ledger_entries
            SET balance_before = CASE
                WHEN direction = 'DEBIT'
                    THEN balance_after + amount
                WHEN direction = 'CREDIT'
                    THEN balance_after - amount
            END;
        `);

        // Torna a coluna obrigatória.
        this.addSql(`
            ALTER TABLE ledger_entries
            ALTER COLUMN balance_before SET NOT NULL;
        `);

        // Impede saldo anterior negativo.
        this.addSql(`
            ALTER TABLE ledger_entries
            ADD CONSTRAINT ck_ledger_balance_before_non_negative
            CHECK (balance_before >= 0);
        `);

        // Garante a consistência matemática do lançamento.
        this.addSql(`
            ALTER TABLE ledger_entries
            ADD CONSTRAINT ck_ledger_balance_consistency
            CHECK (
                (
                    direction = 'DEBIT'
                    AND balance_after = balance_before - amount
                )
                OR
                (
                    direction = 'CREDIT'
                    AND balance_after = balance_before + amount
                )
            );
        `);
    }

    override async down(): Promise<void> {
        // Remove as constraints.
        this.addSql(`
            ALTER TABLE ledger_entries
            DROP CONSTRAINT IF EXISTS ck_ledger_balance_consistency;

            ALTER TABLE ledger_entries
            DROP CONSTRAINT IF EXISTS ck_ledger_balance_before_non_negative;
        `);

        // Remove a coluna adicionada.
        this.addSql(`
            ALTER TABLE ledger_entries
            DROP COLUMN IF EXISTS balance_before;
        `);
    }
}
