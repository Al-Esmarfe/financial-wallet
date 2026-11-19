import { expect } from 'bun:test';
import { Decimal } from 'decimal.js';
import type { MikroORM } from '@mikro-orm/postgresql';

import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { CreateWalletUseCase } from '../../src/application/use-cases/wallets/create-wallet.use-case.js';

/**
 * Abre a wallet pelo MESMO caminho da API (CreateWalletUseCase): saldo inicial
 * positivo gera transação OPENING + lançamento CREDIT. Assim o invariante
 * "saldo == ledger" vale desde o primeiro instante.
 */
export async function openWallet(
    unitOfWork: UnitOfWork,
    walletId: string,
    playerId: string,
    initialBalance: string,
    currency = 'BRL',
): Promise<void> {
    await new CreateWalletUseCase(unitOfWork).execute({
        walletId,
        playerId,
        currency,
        initialBalance,
    });
}

interface LedgerRow {
    direction: 'DEBIT' | 'CREDIT';
    amount: string;
    balance_before: string;
    balance_after: string;
    wallet_version: number;
}

/**
 * Invariante final exigido pelo enunciado (seção 13):
 *
 *   wallet.balance == saldo reconstruído pelo ledger
 *
 * Reconstrói a partir de ZERO na ordem canônica (wallet_version), validando a
 * cadeia balance_before/balance_after de cada lançamento, a contiguidade das
 * versões e que a última versão do ledger é a versão atual da wallet.
 */
export async function expectLedgerMatchesBalance(
    orm: MikroORM,
    walletId: string,
): Promise<{ balance: string; entries: number }> {
    const connection = orm.em.fork().getConnection();
    const [wallet] = await connection.execute<Array<{ balance: string; version: number }>>(
        'SELECT balance::text AS balance, version FROM wallets WHERE id = ?',
        [walletId],
    );
    expect(wallet).toBeDefined();

    const rows = await connection.execute<LedgerRow[]>(
        `SELECT direction, amount::text AS amount, balance_before::text AS balance_before,
                balance_after::text AS balance_after, wallet_version
           FROM ledger_entries WHERE wallet_id = ? ORDER BY wallet_version`,
        [walletId],
    );

    let running = new Decimal(0);
    rows.forEach((row, index) => {
        expect(new Decimal(row.balance_before).toFixed(2)).toBe(running.toFixed(2));
        running =
            row.direction === 'CREDIT'
                ? running.plus(row.amount)
                : running.minus(row.amount);
        expect(running.isNegative()).toBe(false);
        expect(new Decimal(row.balance_after).toFixed(2)).toBe(running.toFixed(2));
        if (index > 0) {
            expect(row.wallet_version).toBe(rows[index - 1]!.wallet_version + 1);
        }
    });

    expect(new Decimal(wallet!.balance).toFixed(2)).toBe(running.toFixed(2));
    if (rows.length > 0) {
        expect(rows[rows.length - 1]!.wallet_version).toBe(wallet!.version);
    }
    return { balance: running.toFixed(2), entries: rows.length };
}
