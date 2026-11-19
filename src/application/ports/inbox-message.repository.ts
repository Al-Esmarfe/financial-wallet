import type { InboxMessage } from '../../domain/messaging/inbox-message.js';

/** Mensagem recebida, modelada pela entidade de domínio `InboxMessage`. */
export type ReceivedInboxMessage = InboxMessage;

/**
 * NEW              primeira vez que a mensagem é vista
 * RETRY            já vista, mas ainda não concluída (reprocessar)
 * DUPLICATE        já concluída com sucesso (devolver o resultado original)
 * PAYLOAD_MISMATCH mesmo messageId com payload diferente (mensagem envenenada)
 */
export type InboxRegistration = 'NEW' | 'RETRY' | 'DUPLICATE' | 'PAYLOAD_MISMATCH';

/** Desfechos que o consumer registra fora da transação financeira (que já sofreu rollback). */
export type InboxFailureOutcome = 'FAILED' | 'REJECTED' | 'DEAD_LETTERED';

export interface InboxMessageRepository {
    registerReceived(message: InboxMessage): Promise<InboxRegistration>;
    markProcessing(consumerName: string, messageId: string): Promise<void>;
    markProcessed(consumerName: string, messageId: string, at: Date): Promise<void>;
    markFailed(consumerName: string, messageId: string, reason: string): Promise<void>;

    /** Upsert do desfecho: cria a linha se o rollback a removeu; nunca rebaixa um PROCESSED. */
    recordOutcome(
        message: InboxMessage,
        outcome: InboxFailureOutcome,
        reason: string,
    ): Promise<void>;

    /** Status atual da mensagem, ou null se nunca foi vista. */
    findStatus(consumerName: string, messageId: string): Promise<string | null>;
}
