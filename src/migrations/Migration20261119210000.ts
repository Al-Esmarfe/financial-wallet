import { Migration } from '@mikro-orm/migrations';

/**
 * `version` da wallet começa em 1 na abertura (seção 6.2) e só cresce: o banco
 * passa a recusar 0, alinhando a constraint ao invariante do domínio.
 */
export class Migration20261119210000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`ALTER TABLE wallets DROP CONSTRAINT ck_wallet_version_non_negative;`);
        this.addSql(`ALTER TABLE wallets ADD CONSTRAINT ck_wallet_version_positive CHECK (version >= 1);`);
    }

    override async down(): Promise<void> {
        this.addSql(`ALTER TABLE wallets DROP CONSTRAINT IF EXISTS ck_wallet_version_positive;`);
        this.addSql(`ALTER TABLE wallets ADD CONSTRAINT ck_wallet_version_non_negative CHECK (version >= 0);`);
    }
}
