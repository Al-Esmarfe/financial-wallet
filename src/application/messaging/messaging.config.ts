/**
 * Resolução das filas SQS a partir do ambiente (lida a cada uso, para que testes
 * possam apontar para filas efêmeras).
 *
 * Topologia (3 papéis, 2 filas FIFO + 1 de eventos):
 *
 *   provedores ──► wager-transactions.fifo  (entrada: WagerTransactionRequested)
 *                       └─ redrive ─► wager-transactions-dlq.fifo
 *
 *   outbox ──────► wager-events.fifo        (saída: eventos de integração)
 *                       └─ redrive ─► wager-events-dlq.fifo
 *
 * Entrada e saída ficam em filas diferentes de propósito: publicar eventos na
 * mesma fila que o consumer lê faria o serviço consumir os próprios eventos.
 *
 * O nome antigo SQS_WAGER_COMMAND_* continua aceito como fallback da fila de
 * ENTRADA. Já SQS_WAGER_QUEUE_URL/SQS_WAGER_DLQ_URL foram removidos: eram
 * ambíguos (configurações antigas os apontavam para wager-transactions.fifo) e
 * faziam o outbox publicar eventos na fila de comandos. `validateMessagingConfig`
 * recusa a inicialização nesses casos.
 */
const clean = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
};

export const messagingConfig = {
    inboundQueueUrl: (): string | undefined =>
        clean(process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL) ??
        clean(process.env.SQS_WAGER_COMMAND_QUEUE_URL),

    inboundDlqUrl: (): string | undefined =>
        clean(process.env.SQS_WAGER_TRANSACTIONS_DLQ_URL) ??
        clean(process.env.SQS_WAGER_COMMAND_DLQ_URL),

    eventsQueueUrl: (): string | undefined =>
        clean(process.env.SQS_WAGER_EVENTS_QUEUE_URL),

    eventsDlqUrl: (): string | undefined =>
        clean(process.env.SQS_WAGER_EVENTS_DLQ_URL),
};

/**
 * Falha rápido (na inicialização) diante de configuração de filas perigosa:
 *  - variáveis removidas e ambíguas (SQS_WAGER_QUEUE_URL / SQS_WAGER_DLQ_URL);
 *  - fila de eventos igual à fila de comandos (o serviço consumiria os próprios eventos).
 */
export function validateMessagingConfig(env: NodeJS.ProcessEnv = process.env): void {
    const removed = ['SQS_WAGER_QUEUE_URL', 'SQS_WAGER_DLQ_URL'].filter((name) => clean(env[name]));
    if (removed.length > 0) {
        throw new Error(
            `${removed.join(', ')} is no longer supported: use SQS_WAGER_TRANSACTIONS_QUEUE_URL / ` +
                'SQS_WAGER_TRANSACTIONS_DLQ_URL (inbound commands) and SQS_WAGER_EVENTS_QUEUE_URL / ' +
                'SQS_WAGER_EVENTS_DLQ_URL (outbound events). See .env.example.',
        );
    }

    const inbound = clean(env.SQS_WAGER_TRANSACTIONS_QUEUE_URL) ?? clean(env.SQS_WAGER_COMMAND_QUEUE_URL);
    const events = clean(env.SQS_WAGER_EVENTS_QUEUE_URL);
    if (inbound && events && inbound === events) {
        throw new Error(
            'SQS_WAGER_EVENTS_QUEUE_URL must differ from SQS_WAGER_TRANSACTIONS_QUEUE_URL: ' +
                'publishing integration events to the command queue makes the service consume its own events.',
        );
    }
}

export function positiveIntegerFromEnv(
    name: string,
    fallback: number,
    env: NodeJS.ProcessEnv = process.env,
): number {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return value;
}
