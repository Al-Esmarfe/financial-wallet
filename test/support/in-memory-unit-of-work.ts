import type {
    TransactionRepositories,
    UnitOfWork,
} from '../../src/application/ports/unit-of-work.js';
import type {
    InboxFailureOutcome,
    InboxMessageRepository,
    InboxRegistration,
    ReceivedInboxMessage,
} from '../../src/application/ports/inbox-message.repository.js';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message.js';

/** Snapshot simples de uma mensagem do outbox (o estado clonado precisa ser dado puro). */
interface OutboxRow { id: string; aggregateType: string; aggregateId: string; eventType: string; payload: Record<string, unknown>; occurredAt: Date }
import { LedgerEntry } from '../../src/domain/ledger/ledger-entry.js';
import { LedgerEntryDirection } from '../../src/domain/ledger/ledger-entry-direction.js';
import { Money } from '../../src/domain/money/money.js';
import { WagerTransaction } from '../../src/domain/transactions/wager-transaction.js';
import { WagerTransactionStatus } from '../../src/domain/transactions/wager-transaction-status.js';
import { WagerTransactionType } from '../../src/domain/transactions/wager-transaction-type.js';
import { Wallet } from '../../src/domain/wallets/wallet.js';

/**
 * Banco em memória com semântica de banco relacional, usado SÓ em testes de
 * unidade da lógica de aplicação:
 *
 *  - cópia na leitura / cópia na escrita (nunca compartilha referências, como um SELECT);
 *  - transação atômica: se a operação lança, TODO o estado volta ao snapshot (rollback);
 *  - UNIQUE (provider, external id), UNIQUE (provider, idempotency key),
 *    UNIQUE ledger(transaction), UNIQUE ledger(wallet, wallet_version) → erro SQLSTATE 23505;
 *  - serialização das transações (equivale ao lock da wallet).
 *
 * NÃO substitui os testes de integração com PostgreSQL real — a concorrência
 * verdadeira é provada em test/integration.
 */
interface WalletRow { id: string; playerId: string; currency: string; balance: string; version: number }
interface TransactionRow {
    id: string; providerId: string; providerTransactionId: string; playerId: string;
    walletId: string; roundId: string; gameId: string; type: WagerTransactionType;
    amount: string; currency: string; idempotencyKey: string; requestHash: string;
    referenceTransactionId?: string; referenceExternalTransactionId?: string;
    status: WagerTransactionStatus; rejectionReason?: string; failureReason?: string;
    failureCode?: never | string; processedAt?: Date; responseBalance?: string;
    referenceAttempts: number; nextReferenceAttemptAt?: Date; referenceExpiresAt?: Date;
}
interface InboxRow { message: ReceivedInboxMessage; status: string; attempts: number; lastError?: string }

export class UniqueViolation extends Error {
    readonly code = '23505';
    constructor(constraint: string) {
        super(`duplicate key value violates unique constraint "${constraint}"`);
    }
}

interface State {
    wallets: Map<string, WalletRow>;
    transactions: Map<string, TransactionRow>;
    ledger: Map<string, LedgerEntry>;
    outbox: OutboxRow[];
    inbox: Map<string, InboxRow>;
}

const clone = (state: State): State => ({
    wallets: new Map([...state.wallets].map(([k, v]) => [k, { ...v }])),
    transactions: new Map([...state.transactions].map(([k, v]) => [k, { ...v }])),
    ledger: new Map(state.ledger),
    outbox: state.outbox.map((e) => ({ ...e })),
    inbox: new Map([...state.inbox].map(([k, v]) => [k, { ...v }])),
});

export class InMemoryDatabase implements UnitOfWork {
    state: State = {
        wallets: new Map(),
        transactions: new Map(),
        ledger: new Map(),
        outbox: [],
        inbox: new Map(),
    };
    /** Quantas transações foram revertidas (rollback). */
    rollbacks = 0;
    private tail: Promise<unknown> = Promise.resolve();

    async execute<T>(
        operation: (repositories: TransactionRepositories) => Promise<T>,
    ): Promise<T> {
        const run = async (): Promise<T> => {
            const snapshot = clone(this.state);
            try {
                return await operation(this.repositories());
            } catch (error) {
                this.state = snapshot;
                this.rollbacks++;
                throw error;
            }
        };
        const result = this.tail.then(run, run);
        this.tail = result.catch(() => undefined);
        return result;
    }

    // ---------------------------------------------------------------- helpers de teste

    /** Cria wallet + lançamento OPENING (como o CreateWalletUseCase), preservando a invariante. */
    seedWallet(options: { balance?: string; playerId?: string; currency?: string } = {}) {
        const id = crypto.randomUUID();
        const playerId = options.playerId ?? `player-${id.slice(0, 8)}`;
        const currency = options.currency ?? 'BRL';
        const balance = options.balance ?? '100.00';
        const wallet = Wallet.open({ id, playerId, initialBalance: Money.create(balance, currency) });
        this.state.wallets.set(id, this.walletToRow(wallet));
        if (Money.create(balance, currency).isPositive()) {
            const opening = WagerTransaction.create({
                id: crypto.randomUUID(), providerId: 'SYSTEM', providerTransactionId: `OPENING:${id}`,
                playerId, walletId: id, roundId: 'SYSTEM_OPENING', gameId: 'INTERNAL',
                type: WagerTransactionType.OPENING, amount: Money.create(balance, currency),
                idempotencyKey: `wallet-opening:${id}`, requestHash: 'o'.repeat(64),
            });
            opening.markProcessed();
            this.state.transactions.set(opening.id, this.txToRow(opening));
            const entry = LedgerEntry.create({
                id: crypto.randomUUID(), walletId: id, transactionId: opening.id,
                transactionType: WagerTransactionType.OPENING, direction: LedgerEntryDirection.CREDIT,
                amount: Money.create(balance, currency), balanceBefore: Money.zero(currency),
                balanceAfter: Money.create(balance, currency), createdAt: new Date().toISOString(),
                walletVersion: 1,
            });
            this.state.ledger.set(entry.id, entry);
        }
        return { walletId: id, playerId, currency };
    }

    wallet(id: string): { balance: string; version: number } {
        const row = this.state.wallets.get(id)!;
        return { balance: row.balance, version: row.version };
    }

    /** Ledger da wallet em ordem canônica (walletVersion). */
    ledgerOf(walletId: string): LedgerEntry[] {
        return [...this.state.ledger.values()]
            .filter((e) => e.walletId === walletId)
            .sort((a, b) => a.walletVersion - b.walletVersion);
    }

    /** Invariante final de todos os testes: saldo materializado == saldo reconstruído pelo ledger. */
    reconstructedBalance(walletId: string): string {
        const row = this.state.wallets.get(walletId)!;
        let balance = Money.zero(row.currency);
        let previousVersion: number | undefined;
        for (const entry of this.ledgerOf(walletId)) {
            if (!entry.balanceBefore.equals(balance)) throw new Error('ledger chain broken (balanceBefore)');
            if (previousVersion !== undefined && entry.walletVersion !== previousVersion + 1) {
                throw new Error('ledger version sequence has a gap');
            }
            previousVersion = entry.walletVersion;
            balance = entry.direction === LedgerEntryDirection.DEBIT
                ? balance.subtract(entry.amount)
                : balance.add(entry.amount);
            if (!balance.equals(entry.balanceAfter)) throw new Error('ledger chain broken (balanceAfter)');
        }
        return balance.toString();
    }

    assertWalletMatchesLedger(walletId: string): void {
        const stored = this.wallet(walletId).balance;
        const rebuilt = this.reconstructedBalance(walletId);
        if (stored !== rebuilt) throw new Error(`wallet ${stored} != ledger ${rebuilt}`);
    }

    transactionsByExternalId(providerId: string, externalId: string): WagerTransaction | undefined {
        const row = [...this.state.transactions.values()].find(
            (t) => t.providerId === providerId && t.providerTransactionId === externalId,
        );
        return row ? this.rowToTx(row) : undefined;
    }

    outboxTypes(): string[] {
        return this.state.outbox.map((e) => e.eventType);
    }

    // ---------------------------------------------------------------- repositórios

    private repositories(): TransactionRepositories {
        const txs = () => [...this.state.transactions.values()];
        const find = (predicate: (row: TransactionRow) => boolean) => {
            const row = txs().find(predicate);
            return Promise.resolve(row ? this.rowToTx(row) : null);
        };

        return {
            wallets: {
                findById: async (id) => {
                    const row = this.state.wallets.get(id);
                    return row ? this.rowToWallet(row) : null;
                },
                findByIdForUpdate: async (id) => {
                    const row = this.state.wallets.get(id);
                    return row ? this.rowToWallet(row) : null;
                },
                findByPlayerAndCurrency: async (playerId, currency) => {
                    const row = [...this.state.wallets.values()].find((w) => w.playerId === playerId && w.currency === currency);
                    return row ? this.rowToWallet(row) : null;
                },
                existsByPlayerAndCurrency: async (playerId, currency) =>
                    [...this.state.wallets.values()].some((w) => w.playerId === playerId && w.currency === currency),
                save: async (wallet) => {
                    const existing = this.state.wallets.get(wallet.id);
                    // Mesma regra do trigger do banco: saldo muda ⇒ versão +1.
                    if (existing && existing.balance !== wallet.balance.toString() && wallet.version !== existing.version + 1) {
                        throw Object.assign(new Error('lost update guard'), { code: '40001' });
                    }
                    if (wallet.balance.isLessThan(Money.zero(wallet.currency))) {
                        throw new Error('ck_wallet_balance_non_negative');
                    }
                    this.state.wallets.set(wallet.id, this.walletToRow(wallet));
                },
            },
            transactions: {
                findById: (id) => find((t) => t.id === id),
                findByIdForUpdate: (id) => find((t) => t.id === id),
                findByProviderAndExternalId: (p, e) => find((t) => t.providerId === p && t.providerTransactionId === e),
                findByProviderAndExternalIdForUpdate: (p, e) => find((t) => t.providerId === p && t.providerTransactionId === e),
                findByIdempotencyKey: (p, k) => find((t) => t.providerId === p && t.idempotencyKey === k),
                findByReferenceExternalId: (p, e) => find((t) => t.providerId === p && t.providerTransactionId === e),
                findByReferenceTransactionIdAndType: (refId, type) =>
                    find((t) => t.referenceTransactionId === refId && t.type === type),
                findPendingReferences: async (now, limit) =>
                    txs()
                        .filter((t) => t.status === WagerTransactionStatus.PENDING_REFERENCE &&
                            t.nextReferenceAttemptAt !== undefined && t.nextReferenceAttemptAt.getTime() <= now.getTime())
                        .slice(0, limit)
                        .map((row) => this.rowToTx(row)),
                save: async (transaction) => {
                    const row = this.txToRow(transaction);
                    for (const other of txs()) {
                        if (other.id === row.id) continue;
                        if (other.providerId === row.providerId && other.providerTransactionId === row.providerTransactionId) {
                            throw new UniqueViolation('uq_provider_transaction');
                        }
                        if (other.providerId === row.providerId && other.idempotencyKey === row.idempotencyKey) {
                            throw new UniqueViolation('uq_provider_idempotency');
                        }
                        if (row.referenceTransactionId && other.referenceTransactionId === row.referenceTransactionId &&
                            [WagerTransactionType.REFUND, WagerTransactionType.ROLLBACK].includes(row.type) &&
                            [WagerTransactionType.REFUND, WagerTransactionType.ROLLBACK].includes(other.type)) {
                            throw new UniqueViolation('uq_wager_transaction_reference_reversal');
                        }
                    }
                    this.state.transactions.set(row.id, row);
                },
            },
            ledger: {
                findById: async (id) => this.state.ledger.get(id) ?? null,
                findByTransactionId: async (transactionId) =>
                    [...this.state.ledger.values()].find((e) => e.transactionId === transactionId) ?? null,
                findByWalletId: async (walletId, limit) => this.ledgerOf(walletId).reverse().slice(0, limit),
                countByWalletId: async (walletId) => this.ledgerOf(walletId).length,
                save: async (entry) => {
                    for (const other of this.state.ledger.values()) {
                        if (other.transactionId === entry.transactionId) throw new UniqueViolation('uq_ledger_transaction');
                        if (other.walletId === entry.walletId && other.walletVersion === entry.walletVersion) {
                            throw new UniqueViolation('uq_ledger_wallet_version');
                        }
                    }
                    this.state.ledger.set(entry.id, entry);
                },
            },
            outbox: {
                enqueue: async (event) => {
                    this.state.outbox.push(toOutboxRow(event));
                },
            },
            inbox: this.inboxRepository(),
        };
    }

    private inboxRepository(): InboxMessageRepository {
        const key = (c: string, m: string) => `${c}|${m}`;
        return {
            registerReceived: async (message): Promise<InboxRegistration> => {
                const existing = this.state.inbox.get(key(message.consumerName, message.messageId));
                if (!existing) {
                    this.state.inbox.set(key(message.consumerName, message.messageId), {
                        message, status: 'RECEIVED', attempts: 0,
                    });
                    return 'NEW';
                }
                if (existing.message.payloadHash !== message.payloadHash) return 'PAYLOAD_MISMATCH';
                return existing.status === 'PROCESSED' ? 'DUPLICATE' : 'RETRY';
            },
            markProcessing: async (c, m) => {
                const row = this.state.inbox.get(key(c, m));
                if (row && row.status !== 'PROCESSED') { row.status = 'PROCESSING'; row.attempts++; }
            },
            markProcessed: async (c, m) => {
                const row = this.state.inbox.get(key(c, m));
                if (row) { row.status = 'PROCESSED'; row.lastError = undefined; }
            },
            markFailed: async (c, m, reason) => {
                const row = this.state.inbox.get(key(c, m));
                if (row && row.status !== 'PROCESSED') { row.status = 'FAILED'; row.lastError = reason; }
            },
            recordOutcome: async (message, outcome: InboxFailureOutcome, reason) => {
                const k = key(message.consumerName, message.messageId);
                const row = this.state.inbox.get(k);
                if (!row) {
                    this.state.inbox.set(k, { message, status: outcome, attempts: 1, lastError: reason });
                } else if (row.status !== 'PROCESSED') {
                    row.status = outcome; row.attempts++; row.lastError = reason;
                }
            },
            findStatus: async (c, m) => this.state.inbox.get(key(c, m))?.status ?? null,
        };
    }

    inboxStatus(consumerName: string, messageId: string): string | undefined {
        return this.state.inbox.get(`${consumerName}|${messageId}`)?.status;
    }

    // ---------------------------------------------------------------- mapeamento row <-> domínio

    private walletToRow(w: Wallet): WalletRow {
        return { id: w.id, playerId: w.playerId, currency: w.currency, balance: w.balance.toString(), version: w.version };
    }
    private rowToWallet(r: WalletRow): Wallet {
        return Wallet.rehydrate({ id: r.id, playerId: r.playerId, currency: r.currency, balance: Money.create(r.balance, r.currency), version: r.version });
    }
    private txToRow(t: WagerTransaction): TransactionRow {
        return {
            id: t.id, providerId: t.providerId, providerTransactionId: t.providerTransactionId,
            playerId: t.playerId, walletId: t.walletId, roundId: t.roundId, gameId: t.gameId, type: t.type,
            amount: t.amount.toString(), currency: t.amount.currency, idempotencyKey: t.idempotencyKey,
            requestHash: t.requestHash, referenceTransactionId: t.referenceTransactionId,
            referenceExternalTransactionId: t.referenceExternalTransactionId, status: t.status,
            rejectionReason: t.rejectionReason, failureReason: t.failureReason, failureCode: t.failureCode,
            processedAt: t.processedAt, responseBalance: t.responseBalance?.toString(),
            referenceAttempts: t.referenceAttempts, nextReferenceAttemptAt: t.nextReferenceAttemptAt,
            referenceExpiresAt: t.referenceExpiresAt,
        };
    }
    private rowToTx(r: TransactionRow): WagerTransaction {
        return WagerTransaction.rehydrate({
            id: r.id, providerId: r.providerId, providerTransactionId: r.providerTransactionId,
            playerId: r.playerId, walletId: r.walletId, roundId: r.roundId, gameId: r.gameId, type: r.type,
            amount: Money.create(r.amount, r.currency), idempotencyKey: r.idempotencyKey, requestHash: r.requestHash,
            referenceTransactionId: r.referenceTransactionId, referenceExternalTransactionId: r.referenceExternalTransactionId,
            status: r.status, rejectionReason: r.rejectionReason, failureReason: r.failureReason,
            failureCode: r.failureCode as never, processedAt: r.processedAt,
            responseBalance: r.responseBalance ? Money.create(r.responseBalance, r.currency) : undefined,
            referenceAttempts: r.referenceAttempts, nextReferenceAttemptAt: r.nextReferenceAttemptAt,
            referenceExpiresAt: r.referenceExpiresAt,
        });
    }
}

function toOutboxRow(message: OutboxMessage): OutboxRow {
    return {
        id: message.id,
        aggregateType: message.aggregateType,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        payload: { ...message.payload },
        occurredAt: message.occurredAt,
    };
}
