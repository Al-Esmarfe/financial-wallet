export interface ReferenceRetryPolicyConfig {
    initialDelayMs: number;
    multiplier: number;
    maxDelayMs: number;
    expirationMs: number;
}

const DEFAULT_CONFIG: ReferenceRetryPolicyConfig = {
    initialDelayMs: 5_000,
    multiplier: 2,
    maxDelayMs: 15 * 60 * 1_000,
    expirationMs: 24 * 60 * 60 * 1_000,
};

export class ReferenceRetryPolicy {
    private readonly config: ReferenceRetryPolicyConfig;

    constructor(config: Partial<ReferenceRetryPolicyConfig> = {}) {
        this.config = {
            ...DEFAULT_CONFIG,
            ...config,
        };

        this.validateConfig();
    }

    getDelayMs(completedAttempts: number): number {
        if (!Number.isSafeInteger(completedAttempts) || completedAttempts < 0) {
            throw new Error(
                'Completed attempts must be a non-negative integer.',
            );
        }

        const delay =
            this.config.initialDelayMs *
            this.config.multiplier ** completedAttempts;

        return Math.min(delay, this.config.maxDelayMs);
    }

    getNextAttemptAt(completedAttempts: number, from: Date = new Date()): Date {
        this.ensureValidDate(from);

        return new Date(from.getTime() + this.getDelayMs(completedAttempts));
    }

    getExpirationAt(createdAt: Date): Date {
        this.ensureValidDate(createdAt);

        return new Date(createdAt.getTime() + this.config.expirationMs);
    }

    isExpired(createdAt: Date, at: Date = new Date()): boolean {
        this.ensureValidDate(createdAt);
        this.ensureValidDate(at);

        return at.getTime() >= this.getExpirationAt(createdAt).getTime();
    }

    private validateConfig(): void {
        const { initialDelayMs, multiplier, maxDelayMs, expirationMs } =
            this.config;

        if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) {
            throw new Error('Initial delay must be greater than zero.');
        }

        if (!Number.isFinite(multiplier) || multiplier <= 1) {
            throw new Error('Multiplier must be greater than one.');
        }

        if (!Number.isFinite(maxDelayMs) || maxDelayMs < initialDelayMs) {
            throw new Error(
                'Maximum delay must be greater than or equal to initial delay.',
            );
        }

        if (!Number.isFinite(expirationMs) || expirationMs <= 0) {
            throw new Error('Expiration must be greater than zero.');
        }

        if (expirationMs <= initialDelayMs) {
            throw new Error(
                'Expiration must be greater than the initial delay.',
            );
        }
    }

    private ensureValidDate(date: Date): void {
        if (Number.isNaN(date.getTime())) {
            throw new Error('Invalid date.');
        }
    }
}
