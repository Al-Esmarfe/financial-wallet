import { EntityManager } from "@mikro-orm/postgresql";

import type {
  InboxFailureOutcome,
  InboxMessageRepository,
  InboxRegistration,
  ReceivedInboxMessage,
} from "../../../application/ports/inbox-message.repository.js";
import { InboxMessageEntity } from "../entities/inbox-message.entity.js";
import {
  InboxMessage,
  type InboxStatus,
} from "../../../domain/messaging/inbox-message.js";

export class MikroOrmInboxMessageRepository implements InboxMessageRepository {
  constructor(private readonly em: EntityManager) {}

  async registerReceived(
    message: ReceivedInboxMessage,
  ): Promise<InboxRegistration> {
    const inserted = await this.em
      .getConnection()
      .execute<Array<{ id: string }>>(
        `INSERT INTO inbox_messages (
                id, consumer_name, message_id, message_group_id, payload_hash,
                payload, status, attempts, received_at
            ) VALUES (?, ?, ?, ?, ?, ?::jsonb, 'RECEIVED', 0, ?)
            ON CONFLICT (consumer_name, message_id) DO NOTHING
            RETURNING id`,
        [
          message.id,
          message.consumerName,
          message.messageId,
          message.messageGroupId ?? null,
          message.payloadHash,
          JSON.stringify(message.payload),
          message.receivedAt,
        ],
        "all",
        this.em.getTransactionContext(),
      );

    if (inserted.length === 1) return "NEW";

    const existing = await this.em.findOne(InboxMessageEntity, {
      consumerName: message.consumerName,
      messageId: message.messageId,
    });

    if (!existing) {
      throw new Error("Inbox message disappeared after a uniqueness conflict.");
    }

    // Linhas antigas (antes de payload_hash existir) não têm hash: não há como comparar.
    if (existing.payloadHash) {
      const stored = InboxMessage.rehydrate({
        id: existing.id,
        consumerName: existing.consumerName,
        messageId: existing.messageId,
        messageGroupId: existing.messageGroupId,
        payloadHash: existing.payloadHash,
        payload: existing.payload,
        receivedAt: existing.receivedAt,
        status: existing.status as InboxStatus,
        processedAt: existing.processedAt,
      });
      if (!stored.matchesPayload(message.payloadHash)) return "PAYLOAD_MISMATCH";
      return stored.isProcessed() ? "DUPLICATE" : "RETRY";
    }

    return existing.status === "PROCESSED" ? "DUPLICATE" : "RETRY";
  }

  async recordOutcome(
    message: ReceivedInboxMessage,
    outcome: InboxFailureOutcome,
    reason: string,
  ): Promise<void> {
    // Upsert: a transação financeira sofreu rollback junto com a linha de Inbox,
    // então o desfecho precisa poder criá-la. Um PROCESSED nunca é rebaixado.
    await this.em.getConnection().execute(
      `INSERT INTO inbox_messages (
                id, consumer_name, message_id, message_group_id, payload_hash,
                payload, status, attempts, received_at, last_error
            ) VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, 1, ?, ?)
            ON CONFLICT (consumer_name, message_id) DO UPDATE
            SET status = EXCLUDED.status,
                attempts = inbox_messages.attempts + 1,
                last_error = EXCLUDED.last_error
            WHERE inbox_messages.status <> 'PROCESSED'`,
      [
        message.id,
        message.consumerName,
        message.messageId,
        message.messageGroupId ?? null,
        message.payloadHash,
        JSON.stringify(message.payload),
        outcome,
        message.receivedAt,
        reason.slice(0, 4000),
      ],
      "run",
      this.em.getTransactionContext(),
    );
  }

  async findStatus(
    consumerName: string,
    messageId: string,
  ): Promise<string | null> {
    const rows = await this.em
      .getConnection()
      .execute<Array<{ status: string }>>(
        `SELECT status FROM inbox_messages WHERE consumer_name = ? AND message_id = ?`,
        [consumerName, messageId],
        "all",
        this.em.getTransactionContext(),
      );
    return rows[0]?.status ?? null;
  }

  async markProcessing(consumerName: string, messageId: string): Promise<void> {
    await this.em.getConnection().execute(
      `UPDATE inbox_messages
             SET status = 'PROCESSING', attempts = attempts + 1
             WHERE consumer_name = ? AND message_id = ? AND status <> 'PROCESSED'`,
      [consumerName, messageId],
      "run",
      this.em.getTransactionContext(),
    );
  }

  async markProcessed(
    consumerName: string,
    messageId: string,
    at: Date,
  ): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageEntity,
      { consumerName, messageId },
      { status: "PROCESSED", processedAt: at, lastError: null },
    );
  }

  async markFailed(
    consumerName: string,
    messageId: string,
    reason: string,
  ): Promise<void> {
    await this.em.getConnection().execute(
      `UPDATE inbox_messages
             SET status = 'FAILED', last_error = ?
             WHERE consumer_name = ? AND message_id = ? AND status <> 'PROCESSED'`,
      [reason.slice(0, 4000), consumerName, messageId],
      "run",
      this.em.getTransactionContext(),
    );
  }
}
