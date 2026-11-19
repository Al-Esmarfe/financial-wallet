import { Migration } from '@mikro-orm/migrations';

export class Migration20261118000000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id VARCHAR(128) NOT NULL,
        currency CHAR(3) NOT NULL,
        balance NUMERIC(20, 2) NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT uq_wallet_player_currency
          UNIQUE (player_id, currency),

        CONSTRAINT ck_wallet_balance_non_negative
          CHECK (balance >= 0),

        CONSTRAINT ck_wallet_version_non_negative
          CHECK (version >= 0),

        CONSTRAINT ck_wallet_currency
          CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);

        this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(100) NOT NULL,
        provider_transaction_id VARCHAR(150) NOT NULL,
        player_id VARCHAR(128) NOT NULL,
        wallet_id UUID NOT NULL,
        round_id VARCHAR(150) NOT NULL,
        type VARCHAR(30) NOT NULL,
        status VARCHAR(30) NOT NULL,
        amount NUMERIC(20, 2) NOT NULL,
        currency CHAR(3) NOT NULL,
        reference_transaction_id UUID NULL,
        idempotency_key VARCHAR(150) NOT NULL,
        request_hash VARCHAR(64) NOT NULL,
        rejection_reason TEXT NULL,
        failure_reason TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT fk_wager_wallet
          FOREIGN KEY (wallet_id)
          REFERENCES wallets(id),

        CONSTRAINT uq_provider_transaction
          UNIQUE (provider_id, provider_transaction_id),

        CONSTRAINT uq_provider_idempotency
          UNIQUE (provider_id, idempotency_key),

        CONSTRAINT ck_wager_type
          CHECK (type IN (
            'OPENING', 'BET', 'WIN', 'LOSS',
            'REFUND', 'ROLLBACK'
          )),

        CONSTRAINT ck_wager_status
          CHECK (status IN (
            'PENDING', 'PENDING_REFERENCE', 'PROCESSED',
            'REJECTED', 'FAILED'
          )),

        CONSTRAINT ck_wager_amount_positive
          CHECK (amount > 0),

        CONSTRAINT ck_wager_currency
          CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);

        this.addSql(`
      CREATE INDEX idx_wager_wallet_created
        ON wager_transactions (wallet_id, created_at DESC);

      CREATE INDEX idx_wager_pending_reference
        ON wager_transactions (created_at)
        WHERE status = 'PENDING_REFERENCE';

      CREATE INDEX idx_wager_reference
        ON wager_transactions (reference_transaction_id)
        WHERE reference_transaction_id IS NOT NULL;

      CREATE UNIQUE INDEX uq_wager_reference_reversal
        ON wager_transactions (reference_transaction_id, type)
        WHERE type IN ('REFUND', 'ROLLBACK')
          AND reference_transaction_id IS NOT NULL;
    `);

        this.addSql(`
      CREATE TABLE ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL,
        transaction_id UUID NOT NULL,
        direction VARCHAR(10) NOT NULL,
        transaction_type VARCHAR(30) NOT NULL,
        amount NUMERIC(20, 2) NOT NULL,
        currency CHAR(3) NOT NULL,
        balance_after NUMERIC(20, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT fk_ledger_wallet
          FOREIGN KEY (wallet_id)
          REFERENCES wallets(id),

        CONSTRAINT fk_ledger_transaction
          FOREIGN KEY (transaction_id)
          REFERENCES wager_transactions(id),

        CONSTRAINT uq_ledger_transaction
          UNIQUE (transaction_id),

        CONSTRAINT ck_ledger_direction
          CHECK (direction IN ('DEBIT', 'CREDIT')),

        CONSTRAINT ck_ledger_amount_positive
          CHECK (amount > 0),

        CONSTRAINT ck_ledger_balance_non_negative
          CHECK (balance_after >= 0)
      );
    `);

        this.addSql(`
      CREATE INDEX idx_ledger_wallet_created
        ON ledger_entries (wallet_id, created_at, id);
    `);

        this.addSql(`
      CREATE TABLE inbox_messages (
        id UUID PRIMARY KEY,
        consumer_name VARCHAR(100) NOT NULL,
        message_id VARCHAR(200) NOT NULL,
        message_group_id VARCHAR(200) NULL,
        payload JSONB NOT NULL,
        status VARCHAR(30) NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ NULL,
        last_error TEXT NULL,

        CONSTRAINT uq_inbox_consumer_message
          UNIQUE (consumer_name, message_id),

        CONSTRAINT ck_inbox_attempts
          CHECK (attempts >= 0),

        CONSTRAINT ck_inbox_status
          CHECK (status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED'))
      );
    `);

        this.addSql(`
      CREATE TABLE outbox_events (
        id UUID PRIMARY KEY,
        aggregate_type VARCHAR(100) NOT NULL,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(30) NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ NULL,
        locked_at TIMESTAMPTZ NULL,
        last_error TEXT NULL,

        CONSTRAINT ck_outbox_attempts
          CHECK (attempts >= 0),

        CONSTRAINT ck_outbox_status
          CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'))
      );
    `);

        this.addSql(`
      CREATE INDEX idx_outbox_pending
        ON outbox_events (occurred_at, id)
        WHERE status = 'PENDING';

      CREATE INDEX idx_inbox_received
        ON inbox_messages (received_at)
        WHERE status IN ('RECEIVED', 'FAILED');
    `);

        // Impede alteração ou exclusão de registros do Ledger.
        this.addSql(`
      CREATE FUNCTION prevent_ledger_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Ledger entries are immutable';
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_ledger_immutable
      BEFORE UPDATE OR DELETE ON ledger_entries
      FOR EACH ROW
      EXECUTE FUNCTION prevent_ledger_mutation();
    `);

        // Impede alteração de transações que já chegaram a um estado terminal.
        this.addSql(`
      CREATE FUNCTION prevent_terminal_transaction_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'Terminal transactions are immutable';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_terminal_transaction_immutable
      BEFORE UPDATE OR DELETE ON wager_transactions
      FOR EACH ROW
      EXECUTE FUNCTION prevent_terminal_transaction_mutation();
    `);
    }

    override async down(): Promise<void> {
        this.addSql(`
      DROP TRIGGER IF EXISTS trg_terminal_transaction_immutable
        ON wager_transactions;

      DROP FUNCTION IF EXISTS prevent_terminal_transaction_mutation();

      DROP TRIGGER IF EXISTS trg_ledger_immutable
        ON ledger_entries;

      DROP FUNCTION IF EXISTS prevent_ledger_mutation();

      DROP TABLE IF EXISTS outbox_events;
      DROP TABLE IF EXISTS inbox_messages;
      DROP TABLE IF EXISTS ledger_entries;
      DROP TABLE IF EXISTS wager_transactions;
      DROP TABLE IF EXISTS wallets;
    `);
    }
}
