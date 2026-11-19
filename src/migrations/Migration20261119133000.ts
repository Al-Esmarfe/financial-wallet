import { Migration } from '@mikro-orm/migrations';

export class Migration20261119133000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`
            CREATE OR REPLACE FUNCTION prevent_terminal_transaction_mutation()
            RETURNS TRIGGER AS $$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
                        RAISE EXCEPTION 'Terminal transactions are immutable';
                    END IF;

                    RETURN OLD;
                END IF;

                IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
                    RAISE EXCEPTION 'Terminal transactions are immutable';
                END IF;

                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);
    }

    override async down(): Promise<void> {
        // Restaura a implementação anterior da função.
        this.addSql(`
            CREATE OR REPLACE FUNCTION prevent_terminal_transaction_mutation()
            RETURNS TRIGGER AS $$
            BEGIN
                IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
                    RAISE EXCEPTION 'Terminal transactions are immutable';
                END IF;

                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);
    }
}
