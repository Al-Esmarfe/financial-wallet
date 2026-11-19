import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";

import { AppModule } from "../../src/app.module.js";
import { configureApp } from "../../src/app.setup.js";

if (process.env.POSTGRES_DB !== "financial_wallet_test") {
  throw new Error("E2E tests must run against financial_wallet_test.");
}

describe("HTTP API (e2e, Postgres real)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Sem fila configurada, os workers ficam inativos: o e2e exercita só HTTP + PG.
    delete process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL;
    delete process.env.SQS_WAGER_COMMAND_QUEUE_URL;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  async function newWallet(amount = "100.00") {
    const playerId = `p-${randomUUID()}`;
    const res = await http()
      .post("/wallets")
      .send({ playerId, initialBalance: { amount, currency: "BRL" } })
      .expect(201);
    return { walletId: res.body.id as string, playerId };
  }

  const wager = (
    w: { walletId: string; playerId: string },
    kind: string,
    amount: string,
    ext: string,
    extra: Record<string, unknown> = {},
  ) => ({
    providerId: "prov-e2e",
    externalTransactionId: ext,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: { amount, currency: "BRL" },
    ...extra,
  });

  it("health e metrics respondem", async () => {
    await http().get("/health/live").expect(200);
    // Sem a fila de entrada configurada (removida no beforeAll), o readiness é 503
    // por contrato (docs/API.md); o Postgres, porém, precisa estar "up".
    const ready = await http().get("/health/ready").expect(503);
    expect(ready.body.dependencies.postgres).toBe("up");
    const res = await http().get("/metrics").expect(200);
    expect(res.text).toContain("wager_transactions_total");
  });

  it("BET + WIN: saldo e extrato corretos, reconciliação consistente", async () => {
    const w = await newWallet("100.00");
    await http()
      .post("/wagering/transactions")
      .set("Idempotency-Key", randomUUID())
      .send(wager(w, "BET", "30.00", `bet-${randomUUID()}`))
      .expect(200);
    const betExt = `bet-${randomUUID()}`;
    const bet = await http()
      .post("/wagering/transactions")
      .set("Idempotency-Key", randomUUID())
      .send(wager(w, "BET", "10.00", betExt))
      .expect(200);
    expect(bet.body.status).toBe("PROCESSED");

    await http()
      .post("/wagering/transactions")
      .set("Idempotency-Key", randomUUID())
      .send(
        wager(w, "WIN", "25.00", `win-${randomUUID()}`, {
          referenceExternalTransactionId: betExt,
        }),
      )
      .expect(200);

    const wallet = await http().get(`/wallets/${w.walletId}`).expect(200);
    expect(wallet.body.balance.amount).toBe("85.00");

    const rec = await http()
      .post(`/wallets/${w.walletId}/reconciliation`)
      .expect(200);
    expect(rec.body.consistent).toBe(true);

    const ledger = await http().get(`/wallets/${w.walletId}/ledger`).expect(200);
    // OPENING (crédito inicial) + BET + BET + WIN
    expect(ledger.body.items.length).toBe(4);
  });

  it("idempotência: repetir a mesma chave não duplica; payload diferente → 409", async () => {
    const w = await newWallet("100.00");
    const key = randomUUID();
    const body = wager(w, "BET", "10.00", `bet-${randomUUID()}`);
    await http().post("/wagering/transactions").set("Idempotency-Key", key).send(body).expect(200);
    const replay = await http()
      .post("/wagering/transactions")
      .set("Idempotency-Key", key)
      .send(body)
      .expect(200);
    expect(replay.body.idempotentReplay).toBe(true);

    await http()
      .post("/wagering/transactions")
      .set("Idempotency-Key", key)
      .send({ ...body, money: { amount: "11.00", currency: "BRL" } })
      .expect(409);

    const wallet = await http().get(`/wallets/${w.walletId}`).expect(200);
    expect(wallet.body.balance.amount).toBe("90.00");
  });

  it("status codes: 400 validação, 404 carteira inexistente, 422 saldo insuficiente, 202 referência pendente", async () => {
    const w = await newWallet("10.00");
    await http()
      .post("/wagering/transactions")
      .set("Idempotency-Key", randomUUID())
      .send({ nonsense: true })
      .expect(400);
    await http()
      .post("/wagering/transactions")
      .send(wager(w, "BET", "1.00", `x-${randomUUID()}`))
      .expect(400); // sem Idempotency-Key

    await http()
      .post("/wagering/transactions")
      .set("Idempotency-Key", randomUUID())
      .send(wager({ walletId: randomUUID(), playerId: "ghost" }, "BET", "1.00", `g-${randomUUID()}`))
      .expect(404);

    await http()
      .post("/wagering/transactions")
      .set("Idempotency-Key", randomUUID())
      .send(wager(w, "BET", "50.00", `big-${randomUUID()}`))
      .expect(422);

    const pending = await http()
      .post("/wagering/transactions")
      .set("Idempotency-Key", randomUUID())
      .send(
        // Só REFUND/ROLLBACK aguardam a referência (WIN credita direto).
        wager(w, "REFUND", "5.00", `refund-${randomUUID()}`, {
          referenceExternalTransactionId: `not-yet-${randomUUID()}`,
        }),
      )
      .expect(202);
    expect(pending.body.status).toBe("PENDING_REFERENCE");
  });

  it("concorrência HTTP: 2 BETs de 80 contra saldo de 100 → um 200 e um 422", async () => {
    const w = await newWallet("100.00");
    const results = await Promise.all(
      [0, 1].map((i) =>
        http()
          .post("/wagering/transactions")
          .set("Idempotency-Key", randomUUID())
          .send(wager(w, "BET", "80.00", `race-${i}-${randomUUID()}`)),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    const wallet = await http().get(`/wallets/${w.walletId}`).expect(200);
    expect(wallet.body.balance.amount).toBe("20.00");
  });
});
