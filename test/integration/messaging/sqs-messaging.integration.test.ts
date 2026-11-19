import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";

import mikroOrmConfig from "../../../mikro-orm.config.js";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message.js";
import { expectLedgerMatchesBalance, openWallet } from "../../support/wallet-invariants.js";
import { MikroOrmUnitOfWork } from "../../../src/infrastructure/database/unit-of-work/mikro-orm-unit-of-work.js";
import { ProcessWagerTransactionUseCase } from "../../../src/application/use-cases/wagering/process-wager-transaction.use-case.js";
import { ReferenceRetryPolicy } from "../../../src/domain/transactions/reference-retry-policy.js";
import { OutboxPublisherWorker } from "../../../src/application/workers/outbox-publisher.worker.js";
import { InboxConsumerWorker } from "../../../src/application/workers/inbox-consumer.worker.js";
import { WalletEntity } from "../../../src/infrastructure/database/entities/wallet.entity.js";
import { LedgerEntryEntity } from "../../../src/infrastructure/database/entities/ledger-entry.entity.js";
import { WagerTransactionEntity } from "../../../src/infrastructure/database/entities/wager-transaction.entity.js";
import { OutboxEventEntity } from "../../../src/infrastructure/database/entities/outbox-event.entity.js";
import { InboxMessageEntity } from "../../../src/infrastructure/database/entities/inbox-message.entity.js";

if (process.env.POSTGRES_DB !== "financial_wallet_test") {
  throw new Error(
    "Messaging integration tests must run against financial_wallet_test.",
  );
}

const region = process.env.AWS_REGION ?? "us-east-1";
const endpoint = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
const base = `${endpoint}/000000000000`;
const inboundUrl =
  process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL ??
  `${base}/wager-transactions.fifo`;
const inboundDlqUrl =
  process.env.SQS_WAGER_TRANSACTIONS_DLQ_URL ??
  `${base}/wager-transactions-dlq.fifo`;
const eventsUrl =
  process.env.SQS_WAGER_EVENTS_QUEUE_URL ?? `${base}/wager-events.fifo`;
const consumerName = "wager-transactions-consumer";

/** Envelope exatamente como no enunciado. */
function envelope(data: Record<string, unknown>, messageId: string = randomUUID()) {
  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data,
  };
}

describe("PostgreSQL + LocalStack SQS messaging integration", () => {
  let orm: MikroORM;
  let unitOfWork: MikroOrmUnitOfWork;
  let sqs: SQSClient;
  let useCase: ProcessWagerTransactionUseCase;

  beforeAll(async () => {
    process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL = inboundUrl;
    process.env.SQS_WAGER_TRANSACTIONS_DLQ_URL = inboundDlqUrl;
    process.env.SQS_WAGER_EVENTS_QUEUE_URL = eventsUrl;
    process.env.INBOX_WAIT_TIME_SECONDS = "1";

    orm = await MikroORM.init(mikroOrmConfig);
    unitOfWork = new MikroOrmUnitOfWork(orm.em);
    useCase = new ProcessWagerTransactionUseCase(
      unitOfWork,
      new ReferenceRetryPolicy(),
    );
    sqs = new SQSClient({
      region,
      endpoint,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
    });

    // Restaura a política de redrive (LocalStack persiste filas entre execuções).
    await ensureRedrive(inboundUrl, inboundDlqUrl, "60");
    // As filas do LocalStack persistem entre execuções (e recebem eventos de outros
    // testes/cargas): começa sempre do zero. PurgeQueue é instantâneo no LocalStack;
    // o drain cobre mensagens que ainda estavam invisíveis no momento do purge.
    for (const url of [inboundUrl, inboundDlqUrl, eventsUrl]) {
      await sqs.send(new PurgeQueueCommand({ QueueUrl: url })).catch(() => undefined);
      await drainQueue(url);
    }
  }, 60_000);

  afterAll(async () => {
    if (sqs) sqs.destroy();
    if (orm) await orm.close(true);
  });

  async function ensureRedrive(
    queueUrl: string,
    dlqUrl: string,
    visibility: string,
  ): Promise<void> {
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: queueUrl,
        Attributes: {
          VisibilityTimeout: visibility,
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: attrs.Attributes?.QueueArn,
            maxReceiveCount: "5",
          }),
        },
      }),
    );
  }

  /** Esvazia a fila por completo (filas do LocalStack persistem entre execuções). */
  async function drainQueue(queueUrl: string): Promise<void> {
    for (let i = 0; i < 10_000; i++) {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
        }),
      );
      const messages = response.Messages ?? [];
      if (messages.length === 0) return;
      await Promise.all(
        messages.flatMap((m) =>
          m.ReceiptHandle
            ? [
                sqs.send(
                  new DeleteMessageCommand({
                    QueueUrl: queueUrl,
                    ReceiptHandle: m.ReceiptHandle,
                  }),
                ),
              ]
            : [],
        ),
      );
    }
  }

  async function receiveAll(queueUrl: string, expected: number) {
    const collected: { Body?: string; ReceiptHandle?: string }[] = [];
    for (let i = 0; i < 10 && collected.length < expected; i++) {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );
      collected.push(...(response.Messages ?? []));
    }
    await Promise.all(
      collected.flatMap((m) =>
        m.ReceiptHandle
          ? [
              sqs.send(
                new DeleteMessageCommand({
                  QueueUrl: queueUrl,
                  ReceiptHandle: m.ReceiptHandle,
                }),
              ),
            ]
          : [],
      ),
    );
    return collected;
  }

  async function seedWallet(balance = "100.00") {
    const walletId = randomUUID();
    const playerId = `player-${walletId}`;
    // Mesmo caminho da API: saldo inicial gera OPENING + lançamento CREDIT.
    await openWallet(unitOfWork, walletId, playerId, balance);
    return { walletId, playerId };
  }

  async function readWalletState(walletId: string) {
    const em = orm.em.fork();
    try {
      const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });
      const ledgerCount = await em.count(LedgerEntryEntity, { walletId });
      return { balance: wallet.balance, ledgerCount };
    } finally {
      em.clear();
    }
  }

  async function enqueueEvent(eventType: string, aggregateId = randomUUID()) {
    const eventId = randomUUID();
    await unitOfWork.execute(async ({ outbox }) => {
      const occurredAt = new Date();
      await outbox!.enqueue(
        OutboxMessage.enqueue(
          {
            eventId,
            eventType,
            aggregateId,
            occurredAt,
            toJSON: () => ({
              eventId,
              eventType,
              aggregateId,
              correlationId: aggregateId,
              occurredAt: occurredAt.toISOString(),
              version: 1,
              data: { transactionId: aggregateId },
            }),
          },
          "WagerTransaction",
        ),
      );
    });
    return { eventId, aggregateId };
  }

  const betData = (walletId: string, playerId: string, amount = "10.00") => {
    const ext = `sqs-${randomUUID()}`;
    return {
      providerId: "provider-sqs",
      externalTransactionId: ext,
      idempotencyKey: `provider-sqs:${ext}`,
      playerId,
      walletId,
      roundId: "round-sqs",
      gameId: "game-sqs",
      kind: "BET",
      money: { amount, currency: "BRL" },
    };
  };

  async function sendCommand(
    body: unknown,
    groupId: string,
  ): Promise<void> {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: inboundUrl,
        MessageBody: typeof body === "string" ? body : JSON.stringify(body),
        MessageGroupId: groupId,
        MessageDeduplicationId: randomUUID(),
      }),
    );
  }

  it("publica eventos do Outbox na fila FIFO real após restart do worker", async () => {
    const { eventId, aggregateId } = await enqueueEvent("integration.recovery");

    // Um worker novo representa outra instância assumindo o trabalho durável.
    const publisher = new OutboxPublisherWorker(orm.em.fork(), sqs);
    const result = await publisher.publishBatch(10, [eventId]);
    expect(result).toEqual({ claimed: 1, published: 1, failed: 0 });

    const em = orm.em.fork();
    try {
      const row = await em.findOneOrFail(OutboxEventEntity, { id: eventId });
      expect(row.status).toBe("PUBLISHED");
      expect(row.publishedAt).toBeInstanceOf(Date);
    } finally {
      await em.nativeDelete(OutboxEventEntity, { id: eventId });
      em.clear();
    }

    const messages = await receiveAll(eventsUrl, 1);
    expect(messages).toHaveLength(1);
    const body = JSON.parse(messages[0]!.Body ?? "{}");
    expect(body.eventId).toBe(eventId);
    expect(body.aggregateId).toBe(aggregateId);
  });

  it("dois publishers independentes reivindicam linhas disjuntas (SKIP LOCKED)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      ids.push((await enqueueEvent("integration.concurrent")).eventId);
    }

    const results = await Promise.all([
      new OutboxPublisherWorker(orm.em.fork(), sqs).publishBatch(8, ids),
      new OutboxPublisherWorker(orm.em.fork(), sqs).publishBatch(8, ids),
    ]);
    expect(results.reduce((s, r) => s + r.published, 0)).toBe(8);
    expect(results.reduce((s, r) => s + r.claimed, 0)).toBe(8);

    const messages = await receiveAll(eventsUrl, 8);
    const received = messages.map((m) => JSON.parse(m.Body ?? "{}").eventId);
    expect(new Set(received)).toEqual(new Set(ids));

    const em = orm.em.fork();
    try {
      await em.nativeDelete(OutboxEventEntity, { id: { $in: ids } });
    } finally {
      em.clear();
    }
  });

  it("crash do publisher entre o envio ao SQS e o PUBLISHED: republicação não duplica (dedup por eventId)", async () => {
    const { eventId } = await enqueueEvent("integration.crash");

    // Publisher A "morreu": enviou ao SQS mas não chegou a marcar PUBLISHED.
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: eventsUrl,
        MessageBody: JSON.stringify({ eventId, eventType: "integration.crash" }),
        MessageGroupId: eventId,
        MessageDeduplicationId: eventId,
      }),
    );

    // O lease/linha continua PENDING; outro publisher reenvia (at-least-once).
    const publisherB = new OutboxPublisherWorker(orm.em.fork(), sqs);
    const result = await publisherB.publishBatch(10, [eventId]);
    expect(result.published).toBe(1);

    // O SQS FIFO deduplica pelo MessageDeduplicationId = eventId: só 1 mensagem.
    const messages = await receiveAll(eventsUrl, 2);
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!.Body ?? "{}").eventId).toBe(eventId);

    const em = orm.em.fork();
    try {
      const row = await em.findOneOrFail(OutboxEventEntity, { id: eventId });
      expect(row.status).toBe("PUBLISHED");
      await em.nativeDelete(OutboxEventEntity, { id: eventId });
    } finally {
      em.clear();
    }
    // receiveAll(…, 2) faz até 10 long polls de 1 s: como a deduplicação deixa
    // só 1 mensagem, ele sempre esgota as tentativas (~10 s).
  }, 30_000);

  it("faz rollback da Inbox quando o caso de uso falha antes do commit", async () => {
    const messageId = `rollback-${randomUUID()}`;
    const input = {
      providerId: "provider-atomicity",
      externalTransactionId: `missing-wallet-${randomUUID()}`,
      idempotencyKey: `provider-atomicity:${randomUUID()}`,
      playerId: `player-${randomUUID()}`,
      walletId: randomUUID(),
      roundId: "round-atomicity",
      gameId: "game-atomicity",
      kind: "BET" as never,
      money: { amount: "10.00", currency: "BRL" },
    };

    await expect(
      useCase.execute(input as never, {
        consumerName,
        messageId,
        payloadHash: "hash",
        payload: input,
      }),
    ).rejects.toThrow();

    const em = orm.em.fork();
    try {
      expect(
        await em.findOne(InboxMessageEntity, { consumerName, messageId }),
      ).toBeNull();
      expect(
        await em.findOne(WagerTransactionEntity, {
          providerId: input.providerId,
          providerTransactionId: input.externalTransactionId,
        }),
      ).toBeNull();
    } finally {
      em.clear();
    }
  });

  it("processa comando real do SQS e sobrevive a falha após o commit e antes do ack", async () => {
    const { walletId, playerId } = await seedWallet();
    const data = betData(walletId, playerId);
    const messageId = `msg-${randomUUID()}`;
    await sendCommand(envelope(data, messageId), walletId);

    process.env.INBOX_VISIBILITY_TIMEOUT_SECONDS = "1";

    let failDeleteOnce = true;
    const flakySqs = {
      send: async (command: unknown) => {
        if (command instanceof DeleteMessageCommand && failDeleteOnce) {
          failDeleteOnce = false;
          throw new Error("simulated crash after commit, before SQS ack");
        }
        return sqs.send(command as never);
      },
    };

    const first = await new InboxConsumerWorker(
      unitOfWork,
      useCase,
      flakySqs as never,
    ).consumeBatch();
    expect(first.processed + first.failed).toBeGreaterThanOrEqual(1);

    // A transação financeira já foi commitada; só o ack falhou. O SQS reentrega
    // depois do backoff do worker (computeRetryDelaySeconds), então consumimos
    // até a reentrega chegar, com prazo, em vez de dormir um tempo fixo.
    const secondWorker = new InboxConsumerWorker(unitOfWork, useCase, sqs);
    const deadline = Date.now() + 15_000;
    let second = await secondWorker.consumeBatch();
    while (second.received === 0 && Date.now() < deadline) {
      second = await secondWorker.consumeBatch();
    }
    expect(second.duplicates).toBe(1);
    expect(second.failed).toBe(0);

    const state = await readWalletState(walletId);
    expect(state.balance).toBe("90.00");
    expect(state.ledgerCount).toBe(2); // OPENING + um único débito
    await expectLedgerMatchesBalance(orm, walletId);

    const em = orm.em.fork();
    try {
      const inbox = await em.findOneOrFail(InboxMessageEntity, {
        consumerName,
        messageId,
      });
      expect(inbox.status).toBe("PROCESSED");
      const txs = await em.find(WagerTransactionEntity, { walletId, type: { $ne: "OPENING" } });
      expect(txs).toHaveLength(1);
      const events = await em.find(OutboxEventEntity, {
        aggregateId: { $in: [txs[0]!.id, walletId] },
      });
      expect(events.map((e) => e.eventType).sort()).toEqual(
        ["WagerTransactionProcessed", "WalletBalanceChanged"].sort(),
      );
      await em.nativeDelete(OutboxEventEntity, {
        id: { $in: events.map((e) => e.id) },
      });
    } finally {
      em.clear();
    }
  }, 30_000);

  it("mensagem inválida vai para a DLQ de aplicação e fica registrada na Inbox", async () => {
    const poison = `not-json-${randomUUID()}`;
    await sendCommand(poison, `poison-${randomUUID()}`);

    const worker = new InboxConsumerWorker(unitOfWork, useCase, sqs);
    const result = await worker.consumeBatch();
    expect(result.deadLettered).toBe(1);

    const dlq = await receiveAll(inboundDlqUrl, 1);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.Body).toBe(poison);
  }, 20_000);

  it("mesma mensagem com payload diferente (mesmo messageId) é recusada, sem efeito financeiro", async () => {
    const { walletId, playerId } = await seedWallet();
    const data = betData(walletId, playerId);
    const messageId = `msg-${randomUUID()}`;
    await sendCommand(envelope(data, messageId), walletId);
    await new InboxConsumerWorker(unitOfWork, useCase, sqs).consumeBatch();

    await sendCommand(
      envelope({ ...data, money: { amount: "99.00", currency: "BRL" } }, messageId),
      walletId,
    );
    await new InboxConsumerWorker(unitOfWork, useCase, sqs).consumeBatch();
    await drainQueue(inboundDlqUrl);

    const state = await readWalletState(walletId);
    expect(state.balance).toBe("90.00");
    expect(state.ledgerCount).toBe(2); // OPENING + um único débito
    await expectLedgerMatchesBalance(orm, walletId);
  }, 30_000);

  it("faz redrive nativo de mensagem nunca confirmada para a DLQ", async () => {
    await ensureRedrive(inboundUrl, inboundDlqUrl, "1");
    try {
      const poisonBody = `invalid-${randomUUID()}`;
      await sendCommand(poisonBody, `poison-${randomUUID()}`);

      let observed = 0;
      let empty = 0;
      for (let i = 0; i < 15 && empty < 3; i++) {
        const response = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: inboundUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 1,
            MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          }),
        );
        const message = response.Messages?.[0];
        if (!message?.ReceiptHandle) {
          empty++;
          continue;
        }
        empty = 0;
        observed = Math.max(
          observed,
          Number(message.Attributes?.ApproximateReceiveCount ?? 0),
        );
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: inboundUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: 0,
          }),
        );
      }
      expect(observed).toBeGreaterThanOrEqual(5);

      const dlq = await receiveAll(inboundDlqUrl, 1);
      expect(dlq[0]?.Body).toBe(poisonBody);
    } finally {
      await ensureRedrive(inboundUrl, inboundDlqUrl, "60");
    }
  }, 40_000);
});
