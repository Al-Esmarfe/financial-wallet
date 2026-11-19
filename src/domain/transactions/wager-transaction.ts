import { Money } from '../money/money.js';
import { WagerTransactionStatus } from './wager-transaction-status.js';
import { WagerTransactionType } from './wager-transaction-type.js';
import { WagerTransactionFailureCode } from './wager-transaction-failure-code.js';
import { LedgerEntryDirection } from '../ledger/ledger-entry-direction.js';
import { CurrencyMismatchError, InvalidTransactionStateError, InvariantViolationError } from '../errors/domain-errors.js';

interface CreateWagerTransactionProps {
    id: string;
    providerId: string;
    providerTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    type: WagerTransactionType;
    amount: Money;
    referenceTransactionId?: string;
    referenceExternalTransactionId?: string;
    idempotencyKey: string;
    requestHash: string;
}

interface RehydrateWagerTransactionProps extends CreateWagerTransactionProps {
    status: WagerTransactionStatus;
    rejectionReason?: string;
    failureReason?: string;
    failureCode?: WagerTransactionFailureCode;
    processedAt?: Date;
    responseBalance?: Money;
    referenceAttempts?: number;
    nextReferenceAttemptAt?: Date;
    referenceExpiresAt?: Date;
}

export class WagerTransaction {
    private currentStatus: WagerTransactionStatus =
        WagerTransactionStatus.PENDING;

    private currentRejectionReason?: string;
    private currentFailureReason?: string;
    private currentFailureCode?: WagerTransactionFailureCode;
    private currentProcessedAt?: Date;
    private currentResponseBalance?: Money;
    private currentReferenceAttempts = 0;
    private currentReferenceTransactionId?: string;
    private currentNextReferenceAttemptAt?: Date;
    private currentReferenceExpiresAt?: Date;

    get status(): WagerTransactionStatus {
        return this.currentStatus;
    }

    get rejectionReason(): string | undefined {
        return this.currentRejectionReason;
    }

    get failureReason(): string | undefined {
        return this.currentFailureReason;
    }

    get failureCode(): WagerTransactionFailureCode | undefined {
        return this.currentFailureCode;
    }

    get processedAt(): Date | undefined {
        return this.currentProcessedAt
            ? new Date(this.currentProcessedAt)
            : undefined;
    }

    get responseBalance(): Money | undefined {
        return this.currentResponseBalance;
    }

    get referenceTransactionId(): string | undefined {
        return this.currentReferenceTransactionId;
    }

    get referenceAttempts(): number {
        return this.currentReferenceAttempts;
    }

    get nextReferenceAttemptAt(): Date | undefined {
        return this.currentNextReferenceAttemptAt
            ? new Date(this.currentNextReferenceAttemptAt)
            : undefined;
    }

    get referenceExpiresAt(): Date | undefined {
        return this.currentReferenceExpiresAt
            ? new Date(this.currentReferenceExpiresAt)
            : undefined;
    }

    private constructor(
        public readonly id: string,
        public readonly providerId: string,
        public readonly providerTransactionId: string,
        public readonly playerId: string,
        public readonly walletId: string,
        public readonly roundId: string,
        public readonly gameId: string,
        public readonly type: WagerTransactionType,
        public readonly amount: Money,
        public readonly idempotencyKey: string,
        public readonly requestHash: string,
        referenceTransactionId?: string,
        public readonly referenceExternalTransactionId?: string,
    ) {
        this.currentReferenceTransactionId = referenceTransactionId;
    }

    static create(props: CreateWagerTransactionProps): WagerTransaction {
        if (
            !props.id.trim() ||
            !props.providerId.trim() ||
            !props.providerTransactionId.trim() ||
            !props.playerId.trim() ||
            !props.walletId.trim() ||
            !props.roundId.trim() ||
            !props.gameId.trim() ||
            !props.idempotencyKey.trim() ||
            !props.requestHash.trim()
        ) {
            throw new InvariantViolationError('Transaction identifiers are required.');
        }

        if (!props.amount.isPositive()) {
            throw new InvariantViolationError('Transaction amount must be greater than zero.');
        }

        const referenceRequired = [
            WagerTransactionType.REFUND,
            WagerTransactionType.ROLLBACK,
        ].includes(props.type);

        if (
            referenceRequired &&
            !props.referenceTransactionId?.trim() &&
            !props.referenceExternalTransactionId?.trim()
        ) {
            throw new InvariantViolationError(
                `${props.type} transactions require a reference transaction.`,
            );
        }

        if (
            props.referenceTransactionId !== undefined &&
            !props.referenceTransactionId.trim()
        ) {
            throw new InvariantViolationError('Reference transaction ID cannot be empty.');
        }

        if (
            props.referenceExternalTransactionId !== undefined &&
            !props.referenceExternalTransactionId.trim()
        ) {
            throw new InvariantViolationError(
                'External reference transaction ID cannot be empty.',
            );
        }

        return new WagerTransaction(
            props.id,
            props.providerId,
            props.providerTransactionId,
            props.playerId,
            props.walletId,
            props.roundId,
            props.gameId,
            props.type,
            props.amount,
            props.idempotencyKey,
            props.requestHash,
            props.referenceTransactionId,
            props.referenceExternalTransactionId,
        );
    }

    static rehydrate(data: RehydrateWagerTransactionProps): WagerTransaction {
        const transaction = new WagerTransaction(
            data.id,
            data.providerId,
            data.providerTransactionId,
            data.playerId,
            data.walletId,
            data.roundId,
            data.gameId,
            data.type,
            data.amount,
            data.idempotencyKey,
            data.requestHash,
            data.referenceTransactionId,
            data.referenceExternalTransactionId,
        );

        transaction.currentStatus = data.status;
        transaction.currentRejectionReason = data.rejectionReason;
        transaction.currentFailureReason = data.failureReason;
        transaction.currentFailureCode = data.failureCode;
        transaction.currentProcessedAt = data.processedAt
            ? new Date(data.processedAt)
            : undefined;
        transaction.currentResponseBalance = data.responseBalance;

        transaction.currentReferenceAttempts = data.referenceAttempts ?? 0;

        if (
            !Number.isSafeInteger(transaction.currentReferenceAttempts) ||
            transaction.currentReferenceAttempts < 0
        ) {
            throw new InvariantViolationError(
                'Reference attempts must be a non-negative integer.',
            );
        }

        if (data.nextReferenceAttemptAt) {
            transaction.ensureValidDate(data.nextReferenceAttemptAt);

            transaction.currentNextReferenceAttemptAt = new Date(
                data.nextReferenceAttemptAt,
            );
        }

        if (data.referenceExpiresAt) {
            transaction.ensureValidDate(data.referenceExpiresAt);

            transaction.currentReferenceExpiresAt = new Date(
                data.referenceExpiresAt,
            );
        }

        return transaction;
    }

    markPendingReference(): void {
        this.ensureNonTerminal();

        this.currentStatus = WagerTransactionStatus.PENDING_REFERENCE;
    }

    initializeReferenceRetrySchedule(
        nextAttemptAt: Date,
        expiresAt: Date,
    ): void {
        if (this.status !== WagerTransactionStatus.PENDING_REFERENCE) {
            throw new InvalidTransactionStateError(
                'Reference retry schedule requires PENDING_REFERENCE status.',
            );
        }

        this.ensureValidDate(nextAttemptAt);
        this.ensureValidDate(expiresAt);

        if (expiresAt.getTime() <= nextAttemptAt.getTime()) {
            throw new InvariantViolationError(
                'Reference expiration must be after the next attempt.',
            );
        }

        this.currentReferenceAttempts = 0;
        this.currentNextReferenceAttemptAt = new Date(nextAttemptAt);
        this.currentReferenceExpiresAt = new Date(expiresAt);
    }

    attachReferenceTransaction(referenceTransactionId: string): void {
        if (this.status !== WagerTransactionStatus.PENDING_REFERENCE) {
            throw new InvalidTransactionStateError(
                'A reference can only be attached to a PENDING_REFERENCE transaction.',
            );
        }

        if (!referenceTransactionId.trim()) {
            throw new InvariantViolationError('Reference transaction ID cannot be empty.');
        }

        if (this.currentReferenceTransactionId) {
            if (this.currentReferenceTransactionId !== referenceTransactionId) {
                throw new InvariantViolationError('A different reference is already attached.');
            }

            return;
        }

        this.currentReferenceTransactionId = referenceTransactionId;
    }

    recordReferenceAttempt(nextAttemptAt: Date): void {
        if (this.status !== WagerTransactionStatus.PENDING_REFERENCE) {
            throw new InvalidTransactionStateError(
                'Reference attempts require PENDING_REFERENCE status.',
            );
        }

        this.ensureValidDate(nextAttemptAt);

        if (!this.currentReferenceExpiresAt) {
            throw new InvariantViolationError('Reference expiration is not configured.');
        }

        if (!Number.isSafeInteger(this.currentReferenceAttempts + 1)) {
            throw new InvariantViolationError(
                'Reference attempts exceeded the safe integer limit.',
            );
        }

        this.currentReferenceAttempts += 1;
        this.currentNextReferenceAttemptAt = new Date(nextAttemptAt);
    }

    markProcessed(at: Date = new Date()): void {
        this.ensureNonTerminal();
        this.ensureValidDate(at);

        this.currentStatus = WagerTransactionStatus.PROCESSED;
        this.currentRejectionReason = undefined;
        this.currentFailureReason = undefined;
        this.currentFailureCode = undefined;
        this.currentProcessedAt = new Date(at);
    }

    /** Toda rejeição carrega um failureCode estável (seção 7.2): o provedor decide por ele. */
    reject(
        reason: string,
        code: WagerTransactionFailureCode,
        at: Date = new Date(),
    ): void {
        this.ensureNonTerminal();
        this.ensureValidDate(at);

        if (!reason.trim()) {
            throw new InvariantViolationError('Rejection reason is required.');
        }

        this.currentStatus = WagerTransactionStatus.REJECTED;
        this.currentRejectionReason = reason;
        this.currentFailureCode = code;
        this.currentProcessedAt = new Date(at);
    }

    setResponseBalance(balance: Money): void {
        this.ensureNonTerminal();

        if (balance.currency !== this.amount.currency) {
            throw new CurrencyMismatchError(
                'Response balance currency must match transaction currency.',
            );
        }

        if (!balance.isPositive() && !balance.isZero()) {
            throw new InvariantViolationError('Response balance cannot be negative.');
        }

        this.currentResponseBalance = balance;
    }

    fail(
        reason: string,
        code: WagerTransactionFailureCode = WagerTransactionFailureCode.INTERNAL_ERROR,
        at: Date = new Date(),
    ): void {
        this.ensureNonTerminal();
        this.ensureValidDate(at);

        if (!reason.trim()) {
            throw new InvariantViolationError('Failure reason is required.');
        }

        this.currentStatus = WagerTransactionStatus.FAILED;
        this.currentFailureReason = reason;
        this.currentFailureCode = code;
        this.currentProcessedAt = new Date(at);
    }

    affectsBalance(): boolean {
        return this.type !== WagerTransactionType.LOSS;
    }

    requiresReference(): boolean {
        return [
            WagerTransactionType.REFUND,
            WagerTransactionType.ROLLBACK,
        ].includes(this.type);
    }

    matchesPayload(payloadHash: string): boolean {
        return this.requestHash === payloadHash;
    }

    ledgerDirectionFor(
        reference?: WagerTransaction,
    ): LedgerEntryDirection | undefined {
        switch (this.type) {
            case WagerTransactionType.OPENING:
            case WagerTransactionType.WIN:
            case WagerTransactionType.REFUND:
                return LedgerEntryDirection.CREDIT;

            case WagerTransactionType.BET:
                return LedgerEntryDirection.DEBIT;

            case WagerTransactionType.LOSS:
                return undefined;

            case WagerTransactionType.ROLLBACK:
                if (!reference) {
                    throw new InvariantViolationError(
                        'ROLLBACK requires a reference transaction.',
                    );
                }

                switch (reference.type) {
                    case WagerTransactionType.BET:
                        return LedgerEntryDirection.CREDIT;

                    case WagerTransactionType.WIN:
                    case WagerTransactionType.REFUND:
                        return LedgerEntryDirection.DEBIT;

                    default:
                        throw new InvariantViolationError(
                            `ROLLBACK cannot reference transaction type ${reference.type}.`,
                        );
                }

            default:
                throw new InvariantViolationError('Unsupported transaction type.');
        }
    }

    private ensureValidDate(date: Date): void {
        if (Number.isNaN(date.getTime())) {
            throw new InvariantViolationError('Invalid transaction date.');
        }
    }

    private ensureNonTerminal(): void {
        const terminalStatuses = [
            WagerTransactionStatus.PROCESSED,
            WagerTransactionStatus.REJECTED,
            WagerTransactionStatus.FAILED,
        ];

        if (terminalStatuses.includes(this.status)) {
            throw new InvalidTransactionStateError(
                `Transaction cannot change from terminal status ${this.status}.`,
            );
        }
    }
}
