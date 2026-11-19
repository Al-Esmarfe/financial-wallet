// O cálculo de backoff é regra pura e vive no domínio (usado por OutboxMessage).
export { exponentialBackoffMs, type BackoffOptions } from '../../domain/messaging/backoff.js';
