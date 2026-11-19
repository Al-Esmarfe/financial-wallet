import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { WalletEntity } from './infrastructure/database/entities/wallet.entity.js';
import { WagerTransactionEntity } from './infrastructure/database/entities/wager-transaction.entity.js';
import { LedgerEntryEntity } from './infrastructure/database/entities/ledger-entry.entity.js';
import { InboxMessageEntity } from './infrastructure/database/entities/inbox-message.entity.js';
import { OutboxEventEntity } from './infrastructure/database/entities/outbox-event.entity.js';
import { MikroOrmUnitOfWork } from './infrastructure/database/unit-of-work/mikro-orm-unit-of-work.js';
import ormConfig from './mikro-orm.config.js';
import { UNIT_OF_WORK } from './application/ports/tokens.js';
import { CreateWalletUseCase } from './application/use-cases/wallets/create-wallet.use-case.js';
import { ReferenceRetryPolicy } from './domain/transactions/reference-retry-policy.js';
import { ProcessWagerTransactionUseCase } from './application/use-cases/wagering/process-wager-transaction.use-case.js';
import { ReferenceRetryWorker } from './application/workers/reference-retry.worker.js';
import { WalletsController } from './interfaces/http/controllers/wallets.controller.js';
import { WageringController } from './interfaces/http/controllers/wagering.controller.js';
import { HealthController } from './interfaces/http/controllers/health.controller.js';
import { ApiExceptionFilter } from './interfaces/http/filters/api-exception.filter.js';
import { ProviderAuthGuard } from './interfaces/http/guards/provider-auth.guard.js';
import { SQS_CLIENT, SqsClientLifecycle, createSqsClient } from './infrastructure/messaging/sqs/sqs-client.provider.js';
import { MetricsController } from './interfaces/http/controllers/metrics.controller.js';
import { OutboxPublisherWorker } from './application/workers/outbox-publisher.worker.js';
import { InboxConsumerWorker } from './application/workers/inbox-consumer.worker.js';

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        MikroOrmModule.forRoot({
            ...ormConfig,
            entities: [WalletEntity, WagerTransactionEntity, LedgerEntryEntity, InboxMessageEntity, OutboxEventEntity],
        }),
    ],
    controllers: [AppController, WalletsController, WageringController, HealthController, MetricsController],
    providers: [
        AppService,
        CreateWalletUseCase,
        { provide: UNIT_OF_WORK, useClass: MikroOrmUnitOfWork },
        ReferenceRetryPolicy,
        ProcessWagerTransactionUseCase,
        ReferenceRetryWorker,
        OutboxPublisherWorker,
        InboxConsumerWorker,
        { provide: SQS_CLIENT, useFactory: createSqsClient },
        SqsClientLifecycle,
        ProviderAuthGuard,
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
    ],
})
export class AppModule {}
