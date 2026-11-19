import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { OutboxPublisherWorker } from "../../../../src/application/workers/outbox-publisher.worker.js";
import { metrics } from "../../../../src/infrastructure/observability/metrics.js";

const saved = {
  events: process.env.SQS_WAGER_EVENTS_QUEUE_URL,
  legacy: process.env.SQS_WAGER_QUEUE_URL,
  maxAttempts: process.env.OUTBOX_MAX_ATTEMPTS,
};

beforeEach(() => {
  delete process.env.SQS_WAGER_EVENTS_QUEUE_URL;
  delete process.env.SQS_WAGER_QUEUE_URL;
  delete process.env.OUTBOX_MAX_ATTEMPTS;
  metrics.outboxPublishedTotal.reset();
  metrics.outboxPublishFailuresTotal.reset();
  metrics.retriesTotal.reset();
});

afterEach(() => {
  for (const [name, value] of [
    ["SQS_WAGER_EVENTS_QUEUE_URL", saved.events],
    ["SQS_WAGER_QUEUE_URL", saved.legacy],
    ["OUTBOX_MAX_ATTEMPTS", saved.maxAttempts],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

interface ClaimedEvent {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

const event = (id: string, aggregate: string, attempts = 1): ClaimedEvent => ({
  id,
  aggregate_id: aggregate,
  event_type: "WagerTransactionProcessed",
  payload: { eventId: id },
  attempts,
});

function createWorker(options?: {
  events?: ClaimedEvent[];
  failOn?: (event: { id: string; aggregate: string }) => Error | undefined;
}) {
  const events = options?.events ?? [event("event-1", "transaction-1")];
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const sent: Array<{ id: string; aggregate: string; dedup: string }> = [];
  const em = {
    transactional: async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        getConnection: () => ({ execute: async () => events }),
        getTransactionContext: () => undefined,
      }),
    nativeUpdate: async (_entity: unknown, where: { id: string }, data: Record<string, unknown>) => {
      updates.push({ id: where.id, data });
      return 1;
    },
  };
  const sqs = {
    send: async (command: { input: { MessageBody: string; MessageGroupId: string; MessageDeduplicationId: string } }) => {
      const payload = JSON.parse(command.input.MessageBody) as { eventId: string };
      const target = { id: payload.eventId, aggregate: command.input.MessageGroupId };
      const error = options?.failOn?.(target);
      if (error) throw error;
      sent.push({ ...target, dedup: command.input.MessageDeduplicationId });
      return {};
    },
    destroy: () => undefined,
  };
  return {
    worker: new OutboxPublisherWorker(em as never, sqs as never),
    updates,
    sent,
    updateFor: (id: string) => updates.filter((u) => u.id === id).map((u) => u.data),
  };
}

describe("OutboxPublisherWorker", () => {
  it("publishes claimed events and marks them as published", async () => {
    process.env.SQS_WAGER_EVENTS_QUEUE_URL = "http://localhost:4566/wager-events.fifo";
    const harness = createWorker();

    const result = await harness.worker.publishBatch(10);

    expect(result).toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(harness.sent).toEqual([{ id: "event-1", aggregate: "transaction-1", dedup: "event-1" }]);
    expect(harness.updates[0]?.data).toMatchObject({ status: "PUBLISHED", lockedAt: null, nextAttemptAt: null });
    expect(metrics.outboxPublishedTotal.total()).toBe(1);
  });

  it("ignores the removed, ambiguous SQS_WAGER_QUEUE_URL variable (never publishes to it)", async () => {
    process.env.SQS_WAGER_QUEUE_URL = "http://localhost:4566/wager-transactions.fifo";
    const harness = createWorker();

    expect((await harness.worker.publishBatch(10)).published).toBe(0);
    expect(harness.sent).toHaveLength(0);
  });

  it("reschedules a failed event with exponential backoff (PENDING + future nextAttemptAt)", async () => {
    process.env.SQS_WAGER_EVENTS_QUEUE_URL = "http://localhost:4566/wager-events.fifo";
    const harness = createWorker({ failOn: () => new Error("SQS unavailable") });
    const before = Date.now();

    const result = await harness.worker.publishBatch(10);

    expect(result).toEqual({ claimed: 1, published: 0, failed: 1 });
    const update = harness.updateFor("event-1")[0]!;
    expect(update).toMatchObject({ status: "PENDING", lockedAt: null, lastError: "SQS unavailable" });
    expect((update.nextAttemptAt as Date).getTime()).toBeGreaterThanOrEqual(before + 1_000); // base 1s
    expect(metrics.retriesTotal.get({ source: "outbox_publish" })).toBe(1);
  });

  it("grows the backoff with the attempt count", async () => {
    process.env.SQS_WAGER_EVENTS_QUEUE_URL = "http://localhost:4566/wager-events.fifo";
    const fresh = createWorker({ events: [event("e", "a", 1)], failOn: () => new Error("x") });
    const tired = createWorker({ events: [event("e", "a", 6)], failOn: () => new Error("x") });

    await fresh.worker.publishBatch(10);
    await tired.worker.publishBatch(10);

    const delay = (h: ReturnType<typeof createWorker>) =>
      (h.updateFor("e")[0]!.nextAttemptAt as Date).getTime() - Date.now();
    expect(delay(tired)).toBeGreaterThan(delay(fresh) * 10); // 64s vs 2s (jitter ≤ 25%)
  });

  it("parks the event as FAILED once attempts reach the limit, but keeps retrying slowly (never dropped)", async () => {
    process.env.SQS_WAGER_EVENTS_QUEUE_URL = "http://localhost:4566/wager-events.fifo";
    process.env.OUTBOX_MAX_ATTEMPTS = "3";
    process.env.OUTBOX_BACKOFF_CAP_MS = "60000";
    // 2 falhas anteriores: esta é a 3ª tentativa, que esgota o limite.
    const harness = createWorker({ events: [event("e", "a", 2)], failOn: () => new Error("still down") });
    const before = Date.now();

    await harness.worker.publishBatch(10);

    const update = harness.updateFor("e")[0]!;
    expect(update).toMatchObject({ status: "FAILED", attempts: 3, lastError: "still down" });
    // Estacionado: próxima tentativa no teto do backoff, não descartado.
    expect((update.nextAttemptAt as Date).getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(metrics.outboxPublishFailuresTotal.get({ terminal: "true" })).toBe(1);
    delete process.env.OUTBOX_BACKOFF_CAP_MS;
  });

  it("publishes the events of one aggregate in order", async () => {
    process.env.SQS_WAGER_EVENTS_QUEUE_URL = "http://localhost:4566/wager-events.fifo";
    const harness = createWorker({
      events: [event("w-1", "wallet-1"), event("w-2", "wallet-1"), event("w-3", "wallet-1")],
    });

    await harness.worker.publishBatch(10);

    expect(harness.sent.map((s) => s.id)).toEqual(["w-1", "w-2", "w-3"]);
  });

  it("on a failure stops that aggregate, returns the untried events WITHOUT burning an attempt, and keeps going with other aggregates", async () => {
    process.env.SQS_WAGER_EVENTS_QUEUE_URL = "http://localhost:4566/wager-events.fifo";
    const harness = createWorker({
      events: [event("w-1", "wallet-1", 1), event("w-2", "wallet-1", 1), event("t-1", "tx-1", 1)],
      failOn: ({ id }) => (id === "w-1" ? new Error("boom") : undefined),
    });

    const result = await harness.worker.publishBatch(10);

    expect(result).toEqual({ claimed: 3, published: 1, failed: 1 });
    expect(harness.sent.map((s) => s.id)).toEqual(["t-1"]); // w-2 não foi enviado antes de w-1
    const failed = harness.updateFor("w-1")[0]!;
    const released = harness.updateFor("w-2")[0]!;
    expect(released).toMatchObject({ status: "PENDING", lockedAt: null }); // sem consumir tentativa
    expect(released).not.toHaveProperty("attempts");
    expect(released.nextAttemptAt).toEqual(failed.nextAttemptAt); // espera junto (preserva a ordem)
    expect(harness.updateFor("t-1")[0]).toMatchObject({ status: "PUBLISHED" });
  });

  it("does not claim events when the queue URL is missing", async () => {
    const harness = createWorker();

    const result = await harness.worker.publishBatch(10);

    expect(result).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(harness.sent).toHaveLength(0);
    expect(harness.updates).toHaveLength(0);
  });

  it("waits for the batch in flight on shutdown and does not close the shared SQS client", async () => {
    process.env.SQS_WAGER_EVENTS_QUEUE_URL = "http://localhost:4566/wager-events.fifo";
    let destroyed = false;
    const harness = createWorker();
    (harness.worker as any).sqs.destroy = () => (destroyed = true);

    const batch = harness.worker.publishBatch(10);
    await harness.worker.onModuleDestroy();
    await batch;

    expect(harness.sent).toHaveLength(1);
    expect(destroyed).toBe(false); // o cliente é fechado por SqsClientLifecycle, depois de todos os workers
  });
});
