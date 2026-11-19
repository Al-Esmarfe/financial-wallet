import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Response } from 'express';

import { SQS_CLIENT } from '../../../infrastructure/messaging/sqs/sqs-client.provider.js';
import { messagingConfig } from '../../../application/messaging/messaging.config.js';

@Controller('health')
export class HealthController {
    constructor(
        @Inject(EntityManager) private readonly em: EntityManager,
        @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    ) {}

    @Get('live')
    @HttpCode(200)
    live() {
        return { status: 'ok', service: 'financial-wallet' };
    }

    @Get('ready')
    async ready(@Res({ passthrough: true }) response: Response) {
        let postgres: 'up' | 'down' = 'down';
        let sqs: 'up' | 'down' = 'down';

        try {
            await this.em.getConnection().execute('SELECT 1');
            postgres = 'up';
        } catch {
            postgres = 'down';
        }

        const outboundQueueUrl = messagingConfig.eventsQueueUrl();
        const inboundQueueUrl = messagingConfig.inboundQueueUrl();
        if (outboundQueueUrl && inboundQueueUrl) {
            try {
                await Promise.all(
                    [outboundQueueUrl, inboundQueueUrl].map((queueUrl) =>
                        this.sqs.send(new GetQueueAttributesCommand({
                            QueueUrl: queueUrl,
                            AttributeNames: ['QueueArn'],
                        })),
                    ),
                );
                sqs = 'up';
            } catch {
                sqs = 'down';
            }
        }

        const ready = postgres === 'up' && sqs === 'up';
        response.status(ready ? 200 : 503);
        return {
            status: ready ? 'ready' : 'not_ready',
            dependencies: { postgres, sqs },
        };
    }
}
