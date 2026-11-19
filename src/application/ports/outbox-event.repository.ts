import type { OutboxMessage } from '../../domain/messaging/outbox-message.js';

export interface OutboxEventRepository {
    /** Persiste a mensagem na MESMA transação SQL da mudança de estado que a originou. */
    enqueue(message: OutboxMessage): Promise<void>;
}
