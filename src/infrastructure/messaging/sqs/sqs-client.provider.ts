import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export function createSqsClient(): SQSClient {
    const endpoint = process.env.SQS_ENDPOINT?.trim();
    const region = process.env.AWS_REGION?.trim() || 'us-east-1';

    return new SQSClient({
        region,
        ...(endpoint
            ? {
                  endpoint,
                  credentials: {
                      accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
                      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
                  },
              }
            : {}),
    });
}

/**
 * Fecha o cliente SQS compartilhado só no `onApplicationShutdown`, que o Nest
 * executa DEPOIS de todos os `onModuleDestroy` (onde os workers terminam o
 * trabalho em andamento). Assim nenhum worker perde o cliente no meio de um envio.
 */
@Injectable()
export class SqsClientLifecycle implements OnApplicationShutdown {
    constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

    onApplicationShutdown(): void {
        this.sqs.destroy();
    }
}
