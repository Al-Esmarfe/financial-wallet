/**
 * Backoff exponencial com teto e jitter opcional.
 *
 *   atraso(tentativa) = min(cap, base * 2^(tentativa-1)) * (1 + jitter * random())
 *
 * `random` é injetável para testes determinísticos. O jitter evita que muitos
 * eventos que falharam juntos (ex.: SQS fora do ar) sejam reenviados todos no
 * mesmo instante ("thundering herd") quando o serviço voltar.
 */
export interface BackoffOptions {
    baseMs?: number;
    capMs?: number;
    /** Fração extra aleatória sobre o atraso, ex.: 0.25 = até +25%. */
    jitterRatio?: number;
    random?: () => number;
}

export function exponentialBackoffMs(
    attempt: number,
    { baseMs = 1_000, capMs = 60_000, jitterRatio = 0.25, random = Math.random }: BackoffOptions = {},
): number {
    if (!Number.isFinite(attempt) || attempt < 1) {
        throw new Error('Backoff attempt must be >= 1.');
    }
    const exponent = Math.min(attempt - 1, 30); // evita overflow de 2 ** n
    const raw = Math.min(capMs, baseMs * 2 ** exponent);
    return Math.round(raw * (1 + jitterRatio * random()));
}
