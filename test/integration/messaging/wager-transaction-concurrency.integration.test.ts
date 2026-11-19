import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";

import mikroOrmConfig from "../../../mikro-orm.config.js";
import { expectLedgerMatchesBalance, openWallet } from "../../support/wallet-invariants.js";
import { MikroOrmUnitOfWork } from "../../../src/infrastructure/database/unit-of-work/mikro-orm-unit-of-work.js";
import { ProcessWagerTransactionUseCase } from "../../../src/application/use-cases/wagering/process-wager-transaction.use-case.js";
import { ReferenceRetryPolicy } from "../../../src/domain/transactions/reference-retry-policy.js";
import { WagerTransactionType } from "../../../src/domain/transactions/wager-transaction-type.js";
import { WalletEntity } from "../../../src/infrastructure/database/entities/wallet.entity.js";
import { LedgerEntryEntity } from "../../../src/infrastructure/database/entities/ledger-entry.entity.js";
import { WagerTransactionEntity } from "../../../src/infrastructure/database/entities/wager-transaction.entity.js";
import { OutboxEventEntity } from "../../../src/infrastructure/database/entities/outbox-event.entity.js";

if (process.env.POSTGRES_DB !== "financial_wallet_test") {
  throw new Error("Integration tests must run against financial_wallet_test.");
}

describe("Wager transaction concurrency across independent database clients", () => {
  let orms: MikroORM[];

  beforeAll(async () => {
    // Three independent MikroORM instances model three application instances:
    // they do not share an EntityManager or an in-process lock.
    orms = await Promise.all([
      MikroORM.init(mikroOrmConfig),
      MikroORM.init(mikroOrmConfig),
      MikroORM.init(mikroOrmConfig),
    ]);
  });

  afterAll(async () => {
    await Promise.all(orms.map((orm) => orm.close(true)));
  });

  const makeUseCase = (orm: MikroORM) =>
    new ProcessWagerTransactionUseCase(
      new MikroOrmUnitOfWork(orm.em),
      new ReferenceRetryPolicy(),
    );

  const seedWallet = async (orm: MikroORM, balance: string) => {
    const walletId = randomUUID();
    const playerId = `player-${walletId}`;
    // Mesmo caminho da API: saldo inicial gera OPENING + lançamento CREDIT.
    await openWallet(new MikroOrmUnitOfWork(orm.em), walletId, playerId, balance);
    return { walletId, playerId };
  };

  const readState = async (orm: MikroORM, walletId: string) => {
    const em = orm.em.fork();
    try {
      const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });
      const ledgerCount = await em.count(LedgerEntryEntity, { walletId });
      const debitCount = await em.count(LedgerEntryEntity, { walletId, direction: "DEBIT" });
      // A transação interna OPENING não é operação do provedor: fica fora das contagens.
      const transactions = await em.find(WagerTransactionEntity, { walletId, type: { $ne: "OPENING" } });
      const transactionCount = transactions.length;
      const outboxCount = await em.count(OutboxEventEntity, {
        aggregateId: { $in: transactions.map((item) => item.id) },
      });
      const balanceChangedCount = await em.count(OutboxEventEntity, {
        aggregateType: "Wallet",
        aggregateId: walletId,
        eventType: "WalletBalanceChanged",
      });
      return {
        balance: wallet.balance,
        ledgerCount,
        debitCount,
        transactionCount,
        outboxCount,
        balanceChangedCount,
      };
    } finally {
      em.clear();
    }
  };

  it("processes the same idempotency key 50 times concurrently with one financial effect", async () => {
    const { walletId, playerId } = await seedWallet(orms[0]!, "100.00");
    const input = {
      providerId: "provider-concurrency",
      externalTransactionId: `same-${randomUUID()}`,
      idempotencyKey: `provider-concurrency:${randomUUID()}`,
      playerId,
      walletId,
      roundId: "round-concurrency",
      gameId: "game-concurrency",
      kind: WagerTransactionType.BET,
      money: { amount: "10.00", currency: "BRL" },
    };

    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          makeUseCase(orms[index % orms.length]!).execute(input),
        ),
      );

      expect(results).toHaveLength(50);
      expect(results.every((result) => result.status === "PROCESSED")).toBe(
        true,
      );
      expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(
        1,
      );

      const state = await readState(orms[0]!, walletId);
      expect(state.balance).toBe("90.00");
      expect(state.ledgerCount).toBe(2); // OPENING + 1 débito
      expect(state.debitCount).toBe(1);
      await expectLedgerMatchesBalance(orms[0]!, walletId);
      expect(state.transactionCount).toBe(1);
      expect(state.outboxCount).toBe(1);
      expect(state.balanceChangedCount).toBe(1);
    } finally {
      const em = orms[0]!.em.fork();
      const transactions = await em.find(WagerTransactionEntity, { walletId });
      await em.nativeDelete(OutboxEventEntity, {
        $or: [
          { aggregateId: { $in: transactions.map((item) => item.id) } },
          { aggregateType: "Wallet", aggregateId: walletId },
        ],
      });

      em.clear();
    }
  });

  it("allows only one of two concurrent 80.00 BETs against a 100.00 balance", async () => {
    const { walletId, playerId } = await seedWallet(orms[0]!, "100.00");
    const base = {
      providerId: "provider-race",
      playerId,
      walletId,
      roundId: "round-race",
      gameId: "game-race",
      kind: WagerTransactionType.BET,
      money: { amount: "80.00", currency: "BRL" },
    };

    try {
      const [first, second] = await Promise.all([
        makeUseCase(orms[0]!).execute({
          ...base,
          externalTransactionId: `bet-a-${randomUUID()}`,
          idempotencyKey: `key-a-${randomUUID()}`,
        }),
        makeUseCase(orms[1]!).execute({
          ...base,
          externalTransactionId: `bet-b-${randomUUID()}`,
          idempotencyKey: `key-b-${randomUUID()}`,
        }),
      ]);

      expect(
        [first.status, second.status].filter(
          (status) => status === "PROCESSED",
        ),
      ).toHaveLength(1);
      expect(
        [first.status, second.status].filter((status) => status === "REJECTED"),
      ).toHaveLength(1);

      const state = await readState(orms[2]!, walletId);
      expect(state.balance).toBe("20.00");
      expect(state.ledgerCount).toBe(2); // OPENING + exatamente 1 débito
      expect(state.debitCount).toBe(1);
      await expectLedgerMatchesBalance(orms[2]!, walletId);
      expect(state.transactionCount).toBe(2);
      expect(state.outboxCount).toBe(2);
      expect(state.balanceChangedCount).toBe(1);
    } finally {
      const em = orms[0]!.em.fork();
      const transactions = await em.find(WagerTransactionEntity, { walletId });
      await em.nativeDelete(OutboxEventEntity, {
        $or: [
          { aggregateId: { $in: transactions.map((item) => item.id) } },
          { aggregateType: "Wallet", aggregateId: walletId },
        ],
      });

      em.clear();
    }
  });
});
