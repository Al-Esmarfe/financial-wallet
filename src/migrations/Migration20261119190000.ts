import { Migration } from '@mikro-orm/migrations';

/**
 * Endurecimento de schema para mensageria e concorrência:
 *
 *  1. Inbox: `payload_hash` (detecta mesmo messageId com payload diferente) e
 *     estados terminais REJECTED (recusa de negócio, ack) e DEAD_LETTERED.
 *  2. Outbox: `next_attempt_at` (backoff exponencial entre tentativas de publicação).
 *  3. Wallet: trigger de progressão de versão — o banco recusa um UPDATE de saldo
 *     que não incrementa `version` em exatamente 1 (guarda contra lost update
 *     mesmo se algum caminho de código esquecer o lock) e recusa mudar
 *     player_id/currency.
 *  4. Ledger: TRUNCATE também é bloqueado (UPDATE/DELETE já eram).
 */
export class Migration20261119190000 extends Migration {
    override async up(): Promise<void> {
        // 1. Inbox
        this.addSql(`ALTER TABLE inbox_messages ADD COLUMN payload_hash VARCHAR(64) NULL;`);
        this.addSql(`ALTER TABLE inbox_messages DROP CONSTRAINT ck_inbox_status;`);
        this.addSql(`
            ALTER TABLE inbox_messages
            ADD CONSTRAINT ck_inbox_status
            CHECK (status IN (
                'RECEIVED', 'PROCESSING', 'PROCESSED',
                'FAILED', 'REJECTED', 'DEAD_LETTERED'
            ));
        `);

        // 2. Outbox
        this.addSql(`ALTER TABLE outbox_events ADD COLUMN next_attempt_at TIMESTAMPTZ NULL;`);

        // 3. Wallet: progressão de versão e imutabilidade de identidade
        this.addSql(`
            CREATE FUNCTION enforce_wallet_update_rules()
            RETURNS TRIGGER AS $$
            BEGIN
                IF NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency THEN
                    RAISE EXCEPTION 'Wallet player_id and currency are immutable';
                END IF;

                IF NEW.balance IS DISTINCT FROM OLD.balance THEN
                    IF NEW.version <> OLD.version + 1 THEN
                        -- 40001 = serialization_failure: classificado como conflito de concorrência
                        RAISE EXCEPTION 'Wallet % balance changed without version increment (lost update guard)', OLD.id
                            USING ERRCODE = '40001';
                    END IF;
                ELSIF NEW.version <> OLD.version THEN
                    RAISE EXCEPTION 'Wallet % version changed without a balance change', OLD.id
                        USING ERRCODE = '40001';
                END IF;

                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);
        this.addSql(`
            CREATE TRIGGER trg_wallet_update_rules
            BEFORE UPDATE ON wallets
            FOR EACH ROW
            EXECUTE FUNCTION enforce_wallet_update_rules();
        `);

        // 4. Ledger: bloqueia TRUNCATE
        this.addSql(`
            CREATE TRIGGER trg_ledger_no_truncate
            BEFORE TRUNCATE ON ledger_entries
            FOR EACH STATEMENT
            EXECUTE FUNCTION prevent_ledger_mutation();
        `);
    }

    override async down(): Promise<void> {
        this.addSql(`DROP TRIGGER IF EXISTS trg_ledger_no_truncate ON ledger_entries;`);
        this.addSql(`DROP TRIGGER IF EXISTS trg_wallet_update_rules ON wallets;`);
        this.addSql(`DROP FUNCTION IF EXISTS enforce_wallet_update_rules();`);

        this.addSql(`ALTER TABLE outbox_events DROP COLUMN IF EXISTS next_attempt_at;`);

        // Linhas já em REJECTED/DEAD_LETTERED voltam para FAILED antes de restaurar a constraint.
        this.addSql(`UPDATE inbox_messages SET status = 'FAILED' WHERE status IN ('REJECTED', 'DEAD_LETTERED');`);
        this.addSql(`ALTER TABLE inbox_messages DROP CONSTRAINT ck_inbox_status;`);
        this.addSql(`
            ALTER TABLE inbox_messages
            ADD CONSTRAINT ck_inbox_status
            CHECK (status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED'));
        `);
        this.addSql(`ALTER TABLE inbox_messages DROP COLUMN IF EXISTS payload_hash;`);
    }
}
