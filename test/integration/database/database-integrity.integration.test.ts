import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
// pg does not ship declarations in this project; keep the integration test
// usable until the package's typings are added.
// @ts-expect-error -- missing declaration file for the pg package
import { Pool, type PoolClient } from 'pg';

const database = process.env.POSTGRES_DB;

if (database !== 'financial_wallet_test') {
    throw new Error(
        'Integration tests must run against financial_wallet_test. ' +
            'Set POSTGRES_DB=financial_wallet_test.',
    );
}

const pool = new Pool({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER ?? 'wallet_user',
    password: process.env.POSTGRES_PASSWORD ?? 'wallet_password',
    database,
});

beforeAll(async () => {
    await pool.query('SELECT 1');
});

afterAll(async () => {
    await pool.end();
});

async function withTransaction(
    operation: (client: PoolClient) => Promise<void>,
): Promise<void> {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        await operation(client);
    } finally {
        try {
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }
    }
}

async function createWallet(client: PoolClient): Promise<string> {
    const id = randomUUID();

    await client.query(
        `INSERT INTO wallets (id, player_id, currency, balance, version)
     VALUES ($1, $2, 'BRL', 100.00, 1)`,
        [id, `player-${id}`],
    );

    return id;
}

async function createTransaction(
    client: PoolClient,
    walletId: string,
    status = 'PROCESSED',
): Promise<string> {
    const id = randomUUID();

    await client.query(
        `INSERT INTO wager_transactions (
            id,
            provider_id,
            provider_transaction_id,
            player_id,
            wallet_id,
            round_id,
            game_id,
            type,
            status,
            amount,
            currency,
            idempotency_key,
            request_hash
        ) VALUES (
            $1,
            'TEST_PROVIDER',
            $2,
            'test-player',
            $3,
            'round-1',
            'game-1',
            'BET',
            $4,
            10.00,
            'BRL',
            $5,
            'test-request-hash'
        )`,
        [id, `external-${id}`, walletId, status, `key-${id}`],
    );

    return id;
}

async function createLedgerEntry(
    client: PoolClient,
    walletId: string,
    transactionId: string,
): Promise<string> {
    const id = randomUUID();

    await client.query(
        `INSERT INTO ledger_entries (
      id,
      wallet_id,
      transaction_id,
      direction,
      transaction_type,
      amount,
      currency,
      balance_before,
      balance_after,
      wallet_version
    ) VALUES ($1, $2, $3, 'DEBIT', 'BET', 10.00, 'BRL', 100.00, 90.00, 2)`,
        [id, walletId, transactionId],
    );

    return id;
}

describe('PostgreSQL database integrity', () => {
    it('prevents updating ledger entries', async () => {
        await withTransaction(async (client) => {
            const walletId = await createWallet(client);
            const transactionId = await createTransaction(client, walletId);
            const ledgerId = await createLedgerEntry(
                client,
                walletId,
                transactionId,
            );

            await expect(
                client.query(
                    'UPDATE ledger_entries SET amount = 20.00 WHERE id = $1',
                    [ledgerId],
                ),
            ).rejects.toThrow('Ledger entries are immutable');
        });
    });

    it('prevents deleting ledger entries', async () => {
        await withTransaction(async (client) => {
            const walletId = await createWallet(client);
            const transactionId = await createTransaction(client, walletId);
            const ledgerId = await createLedgerEntry(
                client,
                walletId,
                transactionId,
            );

            await expect(
                client.query('DELETE FROM ledger_entries WHERE id = $1', [
                    ledgerId,
                ]),
            ).rejects.toThrow('Ledger entries are immutable');
        });
    });

    it('rejects ledger entries with inconsistent balances', async () => {
        await withTransaction(async (client) => {
            const walletId = await createWallet(client);
            const transactionId = await createTransaction(client, walletId);

            await expect(
                client.query(
                    `INSERT INTO ledger_entries (
            id, wallet_id, transaction_id, direction, transaction_type,
            amount, currency, balance_before, balance_after, wallet_version
          ) VALUES ($1, $2, $3, 'CREDIT', 'BET', 10.00, 'BRL', 100.00, 95.00, 2)`,
                    [randomUUID(), walletId, transactionId],
                ),
            ).rejects.toThrow('ck_ledger_balance_consistency');
        });
    });

    it('prevents updating terminal transactions', async () => {
        await withTransaction(async (client) => {
            const walletId = await createWallet(client);
            const transactionId = await createTransaction(client, walletId);

            await expect(
                client.query(
                    `UPDATE wager_transactions
           SET status = 'FAILED'
           WHERE id = $1`,
                    [transactionId],
                ),
            ).rejects.toThrow('Terminal transactions are immutable');
        });
    });

    it('prevents deleting terminal transactions', async () => {
        await withTransaction(async (client) => {
            const walletId = await createWallet(client);
            const transactionId = await createTransaction(client, walletId);

            await expect(
                client.query('DELETE FROM wager_transactions WHERE id = $1', [
                    transactionId,
                ]),
            ).rejects.toThrow('Terminal transactions are immutable');
        });
    });

    // ------------------------------------------------------------------
    // Garantias aplicadas no SCHEMA (seção 5), independentes do código.

    it('recusa saldo negativo na wallet', async () => {
        await withTransaction(async (client) => {
            const walletId = await createWallet(client);
            await expect(
                client.query('UPDATE wallets SET balance = -0.01, version = version + 1 WHERE id = $1', [walletId]),
            ).rejects.toThrow('ck_wallet_balance_non_negative');
        });
    });

    it('recusa wallet com version < 1', async () => {
        await withTransaction(async (client) => {
            const id = randomUUID();
            await expect(
                client.query(
                    `INSERT INTO wallets (id, player_id, currency, balance, version) VALUES ($1, $2, 'BRL', 0, 0)`,
                    [id, `player-${id}`],
                ),
            ).rejects.toThrow('ck_wallet_version_positive');
        });
    });

    it('recusa segunda wallet para o mesmo player + currency', async () => {
        await withTransaction(async (client) => {
            const walletId = await createWallet(client);
            await expect(
                client.query(
                    `INSERT INTO wallets (id, player_id, currency, balance, version) VALUES ($1, $2, 'BRL', 0, 1)`,
                    [randomUUID(), `player-${walletId}`],
                ),
            ).rejects.toThrow('uq_wallet_player_currency');
        });
    });

    it('recusa mudar o saldo sem incrementar version (guarda contra lost update)', async () => {
        await withTransaction(async (client) => {
            const walletId = await createWallet(client);
            await expect(
                client.query('UPDATE wallets SET balance = 50.00 WHERE id = $1', [walletId]),
            ).rejects.toThrow('lost update guard');
        });
    });

    it('recusa reutilizar a idempotency key do mesmo provider', async () => {
        await withTransaction(async (client) => {
            const walletId = await createWallet(client);
            const first = await createTransaction(client, walletId);
            await expect(
                client.query(
                    `INSERT INTO wager_transactions (id, provider_id, provider_transaction_id, player_id, wallet_id,
                        round_id, game_id, type, status, amount, currency, idempotency_key, request_hash)
                     VALUES ($1, 'TEST_PROVIDER', $2, 'test-player', $3, 'round-1', 'game-1', 'BET', 'PROCESSED',
                        10.00, 'BRL', $4, 'other-hash')`,
                    [randomUUID(), `other-${randomUUID()}`, walletId, `key-${first}`],
                ),
            ).rejects.toThrow('uq_provider_idempotency');
        });
    });

    it('recusa segundo lançamento de ledger para a mesma transação', async () => {
        await withTransaction(async (client) => {
            const walletId = await createWallet(client);
            const transactionId = await createTransaction(client, walletId);
            await createLedgerEntry(client, walletId, transactionId);
            await expect(createLedgerEntry(client, walletId, transactionId)).rejects.toThrow(
                'uq_ledger_transaction',
            );
        });
    });

    it('recusa duas reversões (REFUND/ROLLBACK) da mesma referência', async () => {
        await withTransaction(async (client) => {
            const walletId = await createWallet(client);
            const betId = await createTransaction(client, walletId);
            const reversal = (type: string) =>
                client.query(
                    `INSERT INTO wager_transactions (id, provider_id, provider_transaction_id, player_id, wallet_id,
                        round_id, game_id, type, status, amount, currency, idempotency_key, request_hash,
                        reference_transaction_id, reference_external_transaction_id)
                     VALUES ($1, 'TEST_PROVIDER', $2, 'test-player', $3, 'round-1', 'game-1', $4, 'PROCESSED',
                        10.00, 'BRL', $5, 'h', $6, $7)`,
                    [randomUUID(), `rev-${randomUUID()}`, walletId, type, `key-${randomUUID()}`, betId, `external-${betId}`],
                );
            await reversal('REFUND');
            await expect(reversal('ROLLBACK')).rejects.toThrow('uq_wager_transaction_reference_reversal');
        });
    });

    it('recusa valor de transação zero ou negativo', async () => {
        await withTransaction(async (client) => {
            const walletId = await createWallet(client);
            const transactionId = await createTransaction(client, walletId, 'PENDING');
            await expect(
                client.query('UPDATE wager_transactions SET amount = 0 WHERE id = $1', [transactionId]),
            ).rejects.toThrow('ck_wager_amount_positive');
        });
    });
});
