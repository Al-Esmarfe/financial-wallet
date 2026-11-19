import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, UseGuards, Inject } from '@nestjs/common';
import { EntityManager } from "@mikro-orm/postgresql";
import { Logger } from "@nestjs/common";
import { CreateWalletUseCase } from "../../../application/use-cases/wallets/create-wallet.use-case.js";
import { WalletEntity } from "../../../infrastructure/database/entities/wallet.entity.js";
import { LedgerEntryEntity } from "../../../infrastructure/database/entities/ledger-entry.entity.js";
import { MikroOrmLedgerRepository } from "../../../infrastructure/database/repositories/mikro-orm-ledger.repository.js";
import { Money } from "../../../domain/money/money.js";
import { metrics } from "../../../infrastructure/observability/metrics.js";
import { parseCreateWallet, requiredUuid } from "../dto/http.dto.js";
import { ProviderAuthGuard } from "../guards/provider-auth.guard.js";

@UseGuards(ProviderAuthGuard)
@Controller("wallets")
export class WalletsController {
  private readonly logger = new Logger(WalletsController.name);
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    @Inject(EntityManager) private readonly em: EntityManager,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const input = parseCreateWallet(body);
    const result = await this.createWallet.execute({
      playerId: input.playerId,
      currency: input.initialBalance.currency,
      initialBalance: input.initialBalance.amount,
    });
    return {
      id: result.id,
      playerId: result.playerId,
      balance: { amount: result.balance, currency: result.currency },
      version: result.version,
    };
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    const entity = await this.em.findOne(WalletEntity, {
      id: requiredUuid(walletId, "walletId"),
    });
    if (!entity) throw new NotFoundException("Wallet not found.");
    return {
      id: entity.id,
      playerId: entity.playerId,
      balance: { amount: entity.balance, currency: entity.currency },
      version: entity.version,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") rawLimit?: string,
  ) {
    const id = requiredUuid(walletId, "walletId");
    const wallet = await this.em.findOne(WalletEntity, { id });
    if (!wallet) throw new NotFoundException("Wallet not found.");
    if (rawLimit !== undefined && !/^\d+$/.test(rawLimit))
      throw new BadRequestException(
        "limit must be an integer between 1 and 100.",
      );
    const limit = rawLimit === undefined ? 50 : Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException(
        "limit must be an integer between 1 and 100.",
      );
    let decodedCursor: string | undefined;
    if (cursor) {
      try {
        decodedCursor = Buffer.from(cursor, "base64url").toString("utf8");
      } catch {
        throw new BadRequestException("cursor is invalid.");
      }
      if (
        !decodedCursor ||
        Buffer.from(decodedCursor, "utf8").toString("base64url") !== cursor
      )
        throw new BadRequestException("cursor is invalid.");
    }
    const repository = new MikroOrmLedgerRepository(this.em);
    const entries = await repository.findByWalletId(
      id,
      limit + 1,
      decodedCursor,
    );
    const hasMore = entries.length > limit;
    const page = hasMore ? entries.slice(0, limit) : entries;
    const nextCursor =
      hasMore && page.length
        ? Buffer.from(page[page.length - 1]!.id, "utf8").toString("base64url")
        : null;
    return {
      walletId: id,
      items: page.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        transactionType: entry.transactionType,
        money: {
          amount: entry.amount.toString(),
          currency: entry.amount.currency,
        },
        balanceBefore: {
          amount: entry.balanceBefore.toString(),
          currency: entry.balanceBefore.currency,
        },
        balanceAfter: {
          amount: entry.balanceAfter.toString(),
          currency: entry.balanceAfter.currency,
        },
        walletVersion: entry.walletVersion,
        createdAt: entry.createdAt,
      })),
      nextCursor,
    };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconcile(@Param("walletId") walletId: string) {
    const id = requiredUuid(walletId, "walletId");
    const wallet = await this.em.findOne(WalletEntity, { id });
    if (!wallet) throw new NotFoundException("Wallet not found.");
    const entries = await this.em.find(
      LedgerEntryEntity,
      { walletId: id },
      { orderBy: { walletVersion: "ASC" } },
    );
    let calculated = Money.zero(wallet.currency);
    let chainValid = true;
    let versionSequenceValid = true;
    let previousVersion: number | undefined;
    for (const entry of entries) {
      // Sequência contínua (sem buracos): um lançamento ausente quebraria a trilha de auditoria.
      if (
        previousVersion !== undefined &&
        entry.walletVersion !== previousVersion + 1
      )
        versionSequenceValid = false;
      previousVersion = entry.walletVersion;
      const before = Money.create(entry.balanceBefore, entry.currency);
      const amount = Money.create(entry.amount, entry.currency);
      const after = Money.create(entry.balanceAfter, entry.currency);
      if (!calculated.equals(before)) chainValid = false;
      calculated =
        entry.direction === "DEBIT"
          ? calculated.subtract(amount)
          : calculated.add(amount);
      if (!calculated.equals(after)) chainValid = false;
      if (calculated.isLessThan(Money.zero(wallet.currency)))
        chainValid = false;
    }
    const stored = Money.create(wallet.balance, wallet.currency);
    const difference = stored.subtract(calculated);
    const consistent =
      chainValid && versionSequenceValid && stored.equals(calculated);
    if (!consistent) {
      metrics.reconciliationMismatchTotal.inc();
      this.logger.error(
        JSON.stringify({
          event: "wallet_reconciliation_mismatch",
          walletId: id,
          checkedEntries: entries.length,
          chainValid,
          versionSequenceValid,
        }),
      );
    }
    return {
      walletId: id,
      storedBalance: { amount: stored.toString(), currency: stored.currency },
      calculatedBalance: {
        amount: calculated.toString(),
        currency: calculated.currency,
      },
      difference: {
        amount: difference.toString(),
        currency: difference.currency,
      },
      consistent,
      checkedEntries: entries.length,
      ledgerChainValid: chainValid,
      ledgerVersionSequenceValid: versionSequenceValid,
    };
  }
}
