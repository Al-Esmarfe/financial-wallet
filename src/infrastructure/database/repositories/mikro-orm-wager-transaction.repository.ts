import { EntityManager } from "@mikro-orm/postgresql";

import { WagerTransactionRepository } from "../../../application/ports/wager-transaction.repository.js";
import { Money } from "../../../domain/money/money.js";
import { WagerTransaction } from "../../../domain/transactions/wager-transaction.js";
import { WagerTransactionStatus } from "../../../domain/transactions/wager-transaction-status.js";
import { WagerTransactionType } from "../../../domain/transactions/wager-transaction-type.js";
import { WagerTransactionEntity } from "../entities/wager-transaction.entity.js";
import { WagerTransactionFailureCode } from "../../../domain/transactions/wager-transaction-failure-code.js";
import { LockMode } from "@mikro-orm/core";

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, { id });

    return entity ? this.toDomain(entity) : null;
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(
      WagerTransactionEntity,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    return entity ? this.toDomain(entity) : null;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, {
      providerId,
      providerTransactionId: externalTransactionId,
    });

    return entity ? this.toDomain(entity) : null;
  }

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, {
      providerId,
      idempotencyKey,
    });

    return entity ? this.toDomain(entity) : null;
  }

  async findByReferenceExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    // A referência externa identifica a transação original do provedor.
    return this.findByProviderAndExternalId(providerId, externalTransactionId);
  }

  async findPendingReferences(
    now: Date,
    limit: number,
  ): Promise<WagerTransaction[]> {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error("A valid reference date is required.");
    }

    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("Limit must be a positive integer.");
    }

    const entities = await this.em.find(
      WagerTransactionEntity,
      {
        status: WagerTransactionStatus.PENDING_REFERENCE,
        nextReferenceAttemptAt: {
          $lte: now,
        },
      },
      {
        orderBy: {
          nextReferenceAttemptAt: "ASC",
          createdAt: "ASC",
          id: "ASC",
        },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );

    return entities.map((entity) => this.toDomain(entity));
  }

  async save(transaction: WagerTransaction): Promise<void> {
    let entity = await this.em.findOne(WagerTransactionEntity, {
      id: transaction.id,
    });

    const now = new Date();

    if (!entity) {
      entity = this.em.create(WagerTransactionEntity, {
        id: transaction.id,
        providerId: transaction.providerId,
        providerTransactionId: transaction.providerTransactionId,
        playerId: transaction.playerId,
        walletId: transaction.walletId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        type: transaction.type,
        status: transaction.status,
        amount: transaction.amount.toString(),
        currency: transaction.amount.currency,
        referenceTransactionId: transaction.referenceTransactionId,
        referenceExternalTransactionId:
          transaction.referenceExternalTransactionId,
        idempotencyKey: transaction.idempotencyKey,
        requestHash: transaction.requestHash,
        rejectionReason: transaction.rejectionReason,
        failureReason: transaction.failureReason,
        failureCode: transaction.failureCode,
        processedAt: transaction.processedAt,
        createdAt: now,
        updatedAt: now,
        responseBalance: transaction.responseBalance?.toString() ?? null,
        referenceAttempts: transaction.referenceAttempts,
        nextReferenceAttemptAt: transaction.nextReferenceAttemptAt ?? null,
        referenceExpiresAt: transaction.referenceExpiresAt ?? null,
      });

      // As entidades não declaram relações no ORM, então o MikroORM não conhece a
      // dependência ledger_entries → wager_transactions e pode inserir o lançamento
      // antes da transação no commit (viola fk_ledger_transaction). O flush aqui
      // garante que a linha exista antes de qualquer lançamento que a referencie.
      await this.em.persist(entity);
      await this.em.flush();
      return;
    }

    const processedAt = transaction.processedAt;

    const changed =
      entity.status !== transaction.status ||
      entity.referenceTransactionId !== transaction.referenceTransactionId ||
      entity.rejectionReason !== transaction.rejectionReason ||
      entity.failureReason !== transaction.failureReason ||
      entity.failureCode !== transaction.failureCode ||
      (entity.responseBalance ?? undefined) !==
        transaction.responseBalance?.toString() ||
      entity.processedAt?.getTime() !== processedAt?.getTime() ||
      entity.referenceAttempts !== transaction.referenceAttempts ||
      entity.nextReferenceAttemptAt?.getTime() !==
        transaction.nextReferenceAttemptAt?.getTime() ||
      entity.referenceExpiresAt?.getTime() !==
        transaction.referenceExpiresAt?.getTime();

    if (!changed) {
      return;
    }

    entity.status = transaction.status;
    entity.referenceTransactionId = transaction.referenceTransactionId;
    entity.rejectionReason = transaction.rejectionReason;
    entity.failureReason = transaction.failureReason;
    entity.failureCode = transaction.failureCode;
    entity.responseBalance = transaction.responseBalance?.toString() ?? null;
    entity.processedAt = processedAt;
    entity.updatedAt = now;
    entity.referenceAttempts = transaction.referenceAttempts;
    entity.nextReferenceAttemptAt =
      transaction.nextReferenceAttemptAt ?? undefined;
    entity.referenceExpiresAt = transaction.referenceExpiresAt ?? undefined;

    await this.em.persist(entity);
  }

  private toDomain(entity: WagerTransactionEntity): WagerTransaction {
    const amount = Money.create(entity.amount, entity.currency);

    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      providerTransactionId: entity.providerTransactionId,
      playerId: entity.playerId,
      walletId: entity.walletId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      type: entity.type as WagerTransactionType,
      amount,
      idempotencyKey: entity.idempotencyKey,
      requestHash: entity.requestHash,
      referenceTransactionId: entity.referenceTransactionId,
      referenceExternalTransactionId: entity.referenceExternalTransactionId,
      status: entity.status as WagerTransactionStatus,
      rejectionReason: entity.rejectionReason,
      failureReason: entity.failureReason,
      failureCode: entity.failureCode as
        WagerTransactionFailureCode | undefined,
      processedAt: entity.processedAt,
      responseBalance:
        entity.responseBalance != null
          ? Money.create(entity.responseBalance, entity.currency)
          : undefined,
      referenceAttempts: entity.referenceAttempts,
      nextReferenceAttemptAt: entity.nextReferenceAttemptAt,
      referenceExpiresAt: entity.referenceExpiresAt,
    });
  }

  async findByProviderAndExternalIdForUpdate(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(
      WagerTransactionEntity,
      {
        providerId,
        providerTransactionId: externalTransactionId,
      },
      {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      },
    );

    return entity ? this.toDomain(entity) : null;
  }

  async findByReferenceTransactionIdAndType(
    referenceTransactionId: string,
    type: WagerTransactionType,
  ): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, {
      referenceTransactionId,
      type,
    });

    return entity ? this.toDomain(entity) : null;
  }
}
