import { Migration } from '@mikro-orm/migrations';

/**
 * Ordem canônica do ledger por wallet.
 *
 * Problema: `created_at` do lançamento era lido ANTES de obter o lock da wallet.
 * Duas transações concorrentes podem ler o relógio em uma ordem e adquirir o
 * lock em outra — o ledger então mostraria saldos "fora de ordem" e a
 * reconciliação acusaria cadeia quebrada sem haver erro financeiro algum.
 *
 * Solução: `wallet_version` = versão da wallet logo após o lançamento. Como a
 * versão só avança em +1 com o lock da wallet (e o trigger da migration anterior
 * garante isso no banco), a sequência é total, sem buracos e independente de
 * relógio. UNIQUE (wallet_id, wallet_version) impede dois lançamentos na mesma posição.
 */
export class Migration20261119200000 extends Migration {
    override async up(): Promise<void> {
        // O backfill precisa UPDATE em tabela imutável: o trigger é suspenso só nesta transação.
        this.addSql(`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_immutable;`);
        this.addSql(`ALTER TABLE ledger_entries ADD COLUMN wallet_version INTEGER;`);
        this.addSql(`
            UPDATE ledger_entries AS le
            SET wallet_version = ranked.position
            FROM (
                SELECT id,
                       ROW_NUMBER() OVER (PARTITION BY wallet_id ORDER BY created_at, id) AS position
                FROM ledger_entries
            ) AS ranked
            WHERE le.id = ranked.id;
        `);
        this.addSql(`ALTER TABLE ledger_entries ALTER COLUMN wallet_version SET NOT NULL;`);
        this.addSql(`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_immutable;`);

        this.addSql(`
            ALTER TABLE ledger_entries
            ADD CONSTRAINT ck_ledger_wallet_version_positive CHECK (wallet_version >= 1);
        `);
        this.addSql(`
            ALTER TABLE ledger_entries
            ADD CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version);
        `);
    }

    override async down(): Promise<void> {
        this.addSql(`ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS uq_ledger_wallet_version;`);
        this.addSql(`ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ck_ledger_wallet_version_positive;`);
        this.addSql(`ALTER TABLE ledger_entries DROP COLUMN IF EXISTS wallet_version;`);
    }
}
