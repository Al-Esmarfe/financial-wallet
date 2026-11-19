import { Body, Controller, Get, Headers, HttpCode, NotFoundException, Param, Post, Res, UseGuards, Inject } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import type { Response } from 'express';
import { ProcessWagerTransactionUseCase } from '../../../application/use-cases/wagering/process-wager-transaction.use-case.js';
import { WagerTransactionEntity } from '../../../infrastructure/database/entities/wager-transaction.entity.js';
import { WagerTransactionStatus } from '../../../domain/transactions/wager-transaction-status.js';
import { parseSubmitWager, requiredString, requiredUuid } from '../dto/http.dto.js';
import { ProviderAuthGuard } from '../guards/provider-auth.guard.js';

@UseGuards(ProviderAuthGuard)
@Controller()
export class WageringController {
    constructor(
        private readonly processWager: ProcessWagerTransactionUseCase,
        @Inject(EntityManager) private readonly em: EntityManager,
    ) {}

    @Post('wagering/transactions')
    @HttpCode(200)
    async submit(
        @Body() body: unknown,
        @Headers('idempotency-key') idempotencyKey: string | undefined,
        @Res({ passthrough: true }) response: Response,
    ) {
        const key = requiredString(idempotencyKey, 'Idempotency-Key', 150);
        const dto = parseSubmitWager(body);
        const result = await this.processWager.execute({
            ...dto,
            idempotencyKey: key,
        });
        // 200 processada | 202 aceita, referência pendente | 422 recusa de negócio | 503 falha de infraestrutura
        const statusCode =
            result.status === WagerTransactionStatus.PENDING_REFERENCE ? 202
            : result.status === WagerTransactionStatus.REJECTED ? 422
            : result.status === WagerTransactionStatus.FAILED ? 503
            : 200;
        if (statusCode === 503) response.setHeader('Retry-After', '1');
        response.status(statusCode);
        return result;
    }

    @Get('wagering/transactions/:transactionId')
    async getById(@Param('transactionId') transactionId: string) {
        const entity = await this.em.findOne(WagerTransactionEntity, { id: requiredUuid(transactionId, 'transactionId') });
        if (!entity) throw new NotFoundException('Wager transaction not found.');
        return this.toResponse(entity);
    }

    @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
    async getByProviderReference(
        @Param('providerId') providerId: string,
        @Param('externalTransactionId') externalTransactionId: string,
    ) {
        const entity = await this.em.findOne(WagerTransactionEntity, {
            providerId: requiredString(providerId, 'providerId', 100),
            providerTransactionId: requiredString(externalTransactionId, 'externalTransactionId', 150),
        });
        if (!entity) throw new NotFoundException('Wager transaction not found.');
        return this.toResponse(entity);
    }

    private toResponse(entity: WagerTransactionEntity) {
        return {
            transactionId: entity.id,
            providerId: entity.providerId,
            externalTransactionId: entity.providerTransactionId,
            playerId: entity.playerId,
            walletId: entity.walletId,
            roundId: entity.roundId,
            gameId: entity.gameId,
            kind: entity.type,
            status: entity.status,
            money: { amount: entity.amount, currency: entity.currency },
            referenceExternalTransactionId: entity.referenceExternalTransactionId ?? null,
            referenceTransactionId: entity.referenceTransactionId ?? null,
            balance: entity.responseBalance === null || entity.responseBalance === undefined
                ? null
                : { amount: entity.responseBalance, currency: entity.currency },
            failureCode: entity.failureCode ?? null,
            createdAt: entity.createdAt.toISOString(),
            processedAt: entity.processedAt?.toISOString() ?? null,
        };
    }
}
