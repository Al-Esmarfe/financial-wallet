import { InvariantViolationError } from '../errors/domain-errors.js';

/**
 * Estados de uma mensagem na Inbox (deduplicação por consumerName + messageId).
 *
 *   RECEIVED ──► PROCESSING ──► PROCESSED            (terminal, sucesso)
 *                    │
 *                    ├──► FAILED ──► (reentrega) ──► PROCESSING …   (transitório)
 *                    ├──► REJECTED                   (terminal, recusa de negócio)
 *                    └──► DEAD_LETTERED              (terminal, enviada à DLQ)
 */
export type InboxStatus =
    | 'RECEIVED'
    | 'PROCESSING'
    | 'PROCESSED'
    | 'FAILED'
    | 'REJECTED'
    | 'DEAD_LETTERED';

export interface ReceiveInboxProps {
    id: string;
    consumerName: string;
    /** messageId lógico do envelope (não o MessageId do SQS). */
    messageId: string;
    messageGroupId?: string;
    /** sha256 do JSON canônico da mensagem. */
    payloadHash: string;
    payload: Record<string, unknown>;
    receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
    status: InboxStatus;
    processedAt?: Date | null;
}

export class InboxMessage {
    private constructor(
        public readonly id: string,
        public readonly consumerName: string,
        public readonly messageId: string,
        public readonly messageGroupId: string | undefined,
        public readonly payloadHash: string,
        public readonly payload: Readonly<Record<string, unknown>>,
        public readonly receivedAt: Date,
        private _status: InboxStatus,
        private _processedAt?: Date,
    ) {}

    static receive(props: ReceiveInboxProps): InboxMessage {
        if (!props.id.trim() || !props.consumerName.trim() || !props.messageId.trim()) {
            throw new InvariantViolationError('Inbox message identifiers are required.');
        }
        if (!props.payloadHash.trim()) {
            throw new InvariantViolationError('Inbox payload hash is required.');
        }
        return new InboxMessage(
            props.id,
            props.consumerName,
            props.messageId,
            props.messageGroupId,
            props.payloadHash,
            Object.freeze({ ...props.payload }),
            new Date(props.receivedAt),
            'RECEIVED',
        );
    }

    /** Reconstrução a partir da persistência — não revalida transições. */
    static rehydrate(state: InboxMessageState): InboxMessage {
        return new InboxMessage(
            state.id,
            state.consumerName,
            state.messageId,
            state.messageGroupId,
            state.payloadHash,
            Object.freeze({ ...state.payload }),
            new Date(state.receivedAt),
            state.status,
            state.processedAt ? new Date(state.processedAt) : undefined,
        );
    }

    get status(): InboxStatus {
        return this._status;
    }

    get processedAt(): Date | undefined {
        return this._processedAt ? new Date(this._processedAt) : undefined;
    }

    isProcessed(): boolean {
        return this._status === 'PROCESSED';
    }

    /** Já teve um desfecho definitivo (não deve ser reprocessada). */
    isTerminal(): boolean {
        return (
            this._status === 'PROCESSED' ||
            this._status === 'REJECTED' ||
            this._status === 'DEAD_LETTERED'
        );
    }

    /** Mesmo messageId com payload diferente é mensagem envenenada, não reentrega. */
    matchesPayload(payloadHash: string): boolean {
        return this.payloadHash === payloadHash;
    }

    markProcessed(at: Date): void {
        if (this.isTerminal()) {
            throw new InvariantViolationError(
                `Inbox message ${this.messageId} is already terminal (${this._status}).`,
            );
        }
        this._status = 'PROCESSED';
        this._processedAt = new Date(at);
    }
}
