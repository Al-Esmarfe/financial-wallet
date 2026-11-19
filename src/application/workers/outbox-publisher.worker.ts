import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

import { SQS_CLIENT } from "../../infrastructure/messaging/sqs/sqs-client.provider.js";
import { OutboxEventEntity } from "../../infrastructure/database/entities/outbox-event.entity.js";
import {
  messagingConfig,
  positiveIntegerFromEnv,
  validateMessagingConfig,
} from "../messaging/messaging.config.js";
import { OutboxMessage } from "../../domain/messaging/outbox-message.js";
import { metrics, registry } from "../../infrastructure/observability/metrics.js";

interface ClaimedOutboxEvent {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  /** Tentativas de publicação que JÁ falharam (o claim não conta como tentativa). */
  attempts: number;
}

export interface OutboxBatchResult {
  claimed: number;
  published: number;
  failed: number;
}

/** Um publisher que morreu com o lote reservado perde o lease após este intervalo. */
const LEASE_INTERVAL = "2 minutes";

/**
 * Publisher do Transactional Outbox.
 *
 * Várias instâncias podem rodar ao mesmo tempo: a reserva do lote usa
 * `FOR UPDATE SKIP LOCKED`, então cada linha é de um único publisher por vez.
 * Se um publisher morrer depois de reservar (PROCESSING) — ou depois de enviar e
 * antes de marcar PUBLISHED — o lease expira e outra instância reassume:
 * entrega at-least-once. O consumidor deduplica por `eventId`.
 *
 * Ordem: eventos do mesmo aggregate são enviados em sequência (FIFO group =
 * aggregateId); aggregates diferentes são enviados em paralelo.
 */
@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private readonly intervalMs = positiveIntegerFromEnv(
    "OUTBOX_PUBLISH_INTERVAL_MS",
    1_000,
  );
  private readonly batchSize = positiveIntegerFromEnv(
    "OUTBOX_PUBLISH_BATCH_SIZE",
    25,
  );
  private readonly maxAttempts = positiveIntegerFromEnv(
    "OUTBOX_MAX_ATTEMPTS",
    10,
  );
  private readonly backoffBaseMs = positiveIntegerFromEnv(
    "OUTBOX_BACKOFF_BASE_MS",
    1_000,
  );
  private readonly backoffCapMs = positiveIntegerFromEnv(
    "OUTBOX_BACKOFF_CAP_MS",
    60_000,
  );

  private stopping = false;
  private running = false;
  private loopPromise?: Promise<void>;
  private wakeUp?: () => void;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  onModuleInit(): void {
    // Configuração de filas perigosa derruba a inicialização (falha rápida).
    validateMessagingConfig();
    registry.addCollector(() => this.collectGauges());
    this.loopPromise = this.loop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.wakeUp?.();
    await this.loopPromise;
    // O cliente SQS é compartilhado e fechado em SqsClientLifecycle (após todos os workers).
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async publishBatch(
    limit = this.batchSize,
    eventIds?: readonly string[],
  ): Promise<OutboxBatchResult> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("Outbox batch size must be a positive integer.");
    }
    if (eventIds !== undefined && eventIds.length === 0) {
      return { claimed: 0, published: 0, failed: 0 };
    }
    if (this.running) return { claimed: 0, published: 0, failed: 0 };

    this.running = true;
    try {
      const queueUrl = messagingConfig.eventsQueueUrl();
      if (!queueUrl) {
        return { claimed: 0, published: 0, failed: 0 };
      }

      const events = await this.claim(limit, eventIds);

      // Agrupa por aggregate preservando a ordem de reserva (occurred_at, id).
      const groups = new Map<string, ClaimedOutboxEvent[]>();
      for (const event of events) {
        const group = groups.get(event.aggregate_id);
        if (group) group.push(event);
        else groups.set(event.aggregate_id, [event]);
      }

      const outcomes = await Promise.all(
        [...groups.values()].map((group) => this.publishGroup(queueUrl, group)),
      );

      return {
        claimed: events.length,
        published: outcomes.reduce((sum, o) => sum + o.published, 0),
        failed: outcomes.reduce((sum, o) => sum + o.failed, 0),
      };
    } finally {
      this.running = false;
    }
  }

  // ------------------------------------------------------------------ claim

  private async claim(
    limit: number,
    eventIds?: readonly string[],
  ): Promise<ClaimedOutboxEvent[]> {
    return this.em.transactional(async (tx) => {
      const connection = tx.getConnection();
      // Cada UUID entra como parâmetro escalar: passar um array JS pelo
      // placeholder posicional do MikroORM gera literal de array inválido no driver pg.
      const idFilter =
        eventIds === undefined
          ? ""
          : ` AND id IN (${eventIds.map(() => "?").join(", ")})`;
      const params: unknown[] =
        eventIds === undefined ? [limit] : [...eventIds, limit];

      // Elegíveis: PENDING vencido, FAILED "estacionado" vencido (retentativa lenta,
      // nunca descartado) e PROCESSING cujo lease expirou (publisher morreu).
      return connection.execute<ClaimedOutboxEvent[]>(
        `WITH candidates AS (
                    SELECT id
                    FROM outbox_events
                    WHERE (
                          (status IN ('PENDING', 'FAILED') AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()))
                          OR (status = 'PROCESSING' AND locked_at < NOW() - INTERVAL '${LEASE_INTERVAL}')
                      )${idFilter}
                    ORDER BY occurred_at, id
                    FOR UPDATE SKIP LOCKED
                    LIMIT ?
                )
                UPDATE outbox_events AS event
                SET status = 'PROCESSING',
                    locked_at = NOW()
                FROM candidates
                WHERE event.id = candidates.id
                RETURNING event.id, event.aggregate_type, event.aggregate_id, event.event_type,
                          event.payload, event.occurred_at, event.attempts`,
        params,
        "all",
        tx.getTransactionContext(),
      );
    });
  }

  // ---------------------------------------------------------------- publish

  /** Envia os eventos de um aggregate em ordem; ao primeiro erro, devolve o restante ao outbox. */
  private async publishGroup(
    queueUrl: string,
    group: ClaimedOutboxEvent[],
  ): Promise<{ published: number; failed: number }> {
    let published = 0;
    for (let index = 0; index < group.length; index++) {
      const event = group[index]!;
      try {
        await this.sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            // O payload persistido já é o envelope versionado do IntegrationEvent.
            MessageBody: JSON.stringify(event.payload),
            MessageGroupId: event.aggregate_id,
            // Dedup nativa do SQS FIFO (janela de 5 min): otimização, não garantia.
            MessageDeduplicationId: event.id,
          }),
        );

        await this.em.nativeUpdate(
          OutboxEventEntity,
          { id: event.id },
          {
            status: "PUBLISHED",
            publishedAt: new Date(),
            lockedAt: null,
            nextAttemptAt: null,
            lastError: null,
          },
        );
        published++;
        metrics.outboxPublishedTotal.inc({ eventType: event.event_type });
      } catch (error) {
        const nextAttemptAt = await this.failOrRetry(event, error);
        // Os seguintes do mesmo aggregate nem foram tentados: voltam ao outbox, sem
        // consumir tentativa, aguardando junto com o que falhou (preserva a ordem).
        await this.releaseUntried(group.slice(index + 1), nextAttemptAt);
        this.logger.warn(
          JSON.stringify({
            event: "outbox_publish_failed",
            outboxEventId: event.id,
            eventType: event.event_type,
            attempts: event.attempts,
            error: this.message(error),
          }),
        );
        return { published, failed: 1 };
      }
    }
    return { published, failed: 0 };
  }

  /**
   * Registra a falha via `OutboxMessage.scheduleRetry`: backoff exponencial e, ao
   * esgotar `maxAttempts`, FAILED estacionado (retentativa a cada `capMs`). O evento
   * já foi confirmado com a transação financeira: ele nunca é descartado.
   */
  private async failOrRetry(
    event: ClaimedOutboxEvent,
    error: unknown,
  ): Promise<Date | null> {
    const message = OutboxMessage.rehydrate({
      id: event.id,
      aggregateType: event.aggregate_type ?? "unknown",
      aggregateId: event.aggregate_id,
      eventType: event.event_type,
      payload: event.payload,
      occurredAt: event.occurred_at ?? new Date(),
      status: "PROCESSING",
      attempts: event.attempts,
    });
    message.scheduleRetry(new Date(), {
      maxAttempts: this.maxAttempts,
      baseMs: this.backoffBaseMs,
      capMs: this.backoffCapMs,
    }, this.message(error));

    const parked = message.isParked();
    const nextAttemptAt = message.nextAttemptAt ?? null;

    await this.em.nativeUpdate(
      OutboxEventEntity,
      { id: event.id },
      {
        status: message.status,
        attempts: message.attempts,
        lockedAt: null,
        nextAttemptAt,
        lastError: message.lastError ?? null,
      },
    );

    metrics.outboxPublishFailuresTotal.inc({ terminal: String(parked) });
    if (parked) {
      metrics.dlqMessagesTotal.inc({ queue: "outbox", reason: "MAX_ATTEMPTS_EXCEEDED" });
    }
    metrics.retriesTotal.inc({ source: "outbox_publish" });
    return nextAttemptAt;
  }

  private async releaseUntried(
    events: ClaimedOutboxEvent[],
    nextAttemptAt: Date | null,
  ): Promise<void> {
    for (const event of events) {
      await this.em.nativeUpdate(
        OutboxEventEntity,
        { id: event.id },
        {
          status: "PENDING",
          lockedAt: null,
          nextAttemptAt,
        },
      );
    }
  }

  // ------------------------------------------------------------------ loop

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let claimed = 0;
      try {
        const result = await this.publishBatch();
        claimed = result.claimed;
        if (claimed > 0) {
          this.logger.log(JSON.stringify({ event: "outbox_batch", ...result }));
        }
      } catch (error) {
        this.logger.error(
          JSON.stringify({ event: "outbox_batch_failed", error: this.message(error) }),
        );
      }
      // Havia trabalho: drena sem pausa. Caso contrário, espera o intervalo.
      if (claimed === 0 && !this.stopping) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.intervalMs);
          this.wakeUp = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  }

  /** Gauges calculados no scrape: backlog, idade do evento mais antigo e eventos esgotados. */
  private async collectGauges(): Promise<void> {
    const rows = await this.em.getConnection().execute<
      Array<{ pending: number; failed: number; lag: number }>
    >(
      `SELECT
           COUNT(*) FILTER (WHERE status IN ('PENDING', 'PROCESSING'))::int AS pending,
           COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
           COALESCE(EXTRACT(EPOCH FROM (
               NOW() - MIN(occurred_at) FILTER (WHERE status IN ('PENDING', 'PROCESSING'))
           )), 0)::float AS lag
       FROM outbox_events
       WHERE status IN ('PENDING', 'PROCESSING', 'FAILED')`,
    );
    const row = rows[0];
    metrics.outboxPending.set(Number(row?.pending ?? 0));
    metrics.outboxFailed.set(Number(row?.failed ?? 0));
    metrics.outboxLagSeconds.set(Number(row?.lag ?? 0));
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
