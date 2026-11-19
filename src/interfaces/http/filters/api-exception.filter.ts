import {
    ArgumentsHost,
    Catch,
    ExceptionFilter,
    HttpException,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ApplicationError } from '../../../application/errors/application-errors.js';
import {
    CurrencyMismatchError,
    DomainError,
    InsufficientFundsError,
    InvalidMoneyError,
} from '../../../domain/errors/domain-errors.js';
import { postgresErrorCode } from '../../../infrastructure/observability/metrics.js';

/**
 * Contrato de erro HTTP — o mesmo para TODOS os endpoints.
 *
 * O provedor decide o que fazer só pelo status (e, se quiser detalhe, pelo `code`):
 *
 *   400  payload inválido                         → corrigir o payload; NÃO reenviar igual
 *   404  wallet/transação inexistente             → corrigir o identificador
 *   409  conflito (idempotency key com payload    → NÃO reenviar igual; há decisão a tomar
 *        diferente, external id reutilizado,
 *        wallet duplicada)
 *   422  rejeição de regra de negócio             → terminal; NÃO reenviar igual
 *   202  aceita, processamento pendente           → (não é erro) consultar depois
 *   503  falha transitória de infraestrutura      → reenviar com a MESMA Idempotency-Key
 *        (inclui header Retry-After)
 *   500  erro inesperado do serviço               → reenviar com a mesma key é seguro
 *
 * `retryable` repete isso em forma legível por máquina.
 */
const TRANSIENT_CONNECTION_CODES = new Set([
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ECONNRESET',
    'ENOTFOUND',
    'EPIPE',
]);

/** SQLSTATE: deadlock, serialização, lock indisponível, admin shutdown, excesso de conexões. */
const TRANSIENT_PG_CODES = new Set(['40P01', '40001', '55P03', '57P01', '57P03', '53300']);

const RETRY_AFTER_SECONDS = 1;

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(ApiExceptionFilter.name);

    catch(exception: unknown, host: ArgumentsHost): void {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        const { status, code, message } = this.translate(exception, request);
        const retryable = status === 503 || status === 500;

        if (status === 503) {
            response.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
        }

        response.status(status).json({
            statusCode: status,
            code,
            message,
            retryable,
            path: request.url,
            timestamp: new Date().toISOString(),
        });
    }

    private translate(
        exception: unknown,
        request: Request,
    ): { status: number; code: string; message: string } {
        if (exception instanceof HttpException) {
            const status = exception.getStatus();
            const payload = exception.getResponse();
            const message =
                typeof payload === 'string'
                    ? payload
                    : ((payload as { message?: string | string[] }).message?.toString() ??
                      exception.message);
            const code =
                status === 400 ? 'VALIDATION_ERROR'
                : status === 404 ? 'NOT_FOUND'
                : status === 409 ? 'CONFLICT'
                : status === 422 ? 'BUSINESS_REJECTED'
                : status === 503 ? 'SERVICE_UNAVAILABLE'
                : 'HTTP_ERROR';
            return { status, code, message };
        }

        if (exception instanceof ApplicationError) {
            const status =
                exception.category === 'VALIDATION' ? HttpStatus.BAD_REQUEST
                : exception.category === 'CONFLICT' ? HttpStatus.CONFLICT
                : exception.category === 'NOT_FOUND' ? HttpStatus.NOT_FOUND
                : HttpStatus.UNPROCESSABLE_ENTITY;
            return { status, code: exception.code, message: exception.message };
        }

        if (exception instanceof DomainError) {
            if (exception instanceof InvalidMoneyError) {
                return { status: HttpStatus.BAD_REQUEST, code: 'VALIDATION_ERROR', message: exception.message };
            }
            if (
                exception instanceof CurrencyMismatchError ||
                exception instanceof InsufficientFundsError
            ) {
                return { status: HttpStatus.UNPROCESSABLE_ENTITY, code: exception.code, message: exception.message };
            }
            // Invariante violada / transição inválida: bug nosso, não do provedor.
            this.logUnexpected(request, exception);
            return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' };
        }

        if (exception instanceof Error) {
            const pgCode = postgresErrorCode(exception);
            const nodeCode = (exception as { code?: string }).code;

            // Corrida na criação de wallet resolvida pelo índice único (player_id, currency).
            if (pgCode === '23505') {
                return {
                    status: HttpStatus.CONFLICT,
                    code: 'WALLET_ALREADY_EXISTS',
                    message: 'A wallet already exists for this player and currency.',
                };
            }

            if (
                (pgCode && (TRANSIENT_PG_CODES.has(pgCode) || pgCode.startsWith('08'))) ||
                (nodeCode && TRANSIENT_CONNECTION_CODES.has(nodeCode)) ||
                /connection terminated|connection timeout|timeout exceeded when trying to connect/i.test(exception.message)
            ) {
                this.logUnexpected(request, exception, true);
                return {
                    status: HttpStatus.SERVICE_UNAVAILABLE,
                    code: 'SERVICE_UNAVAILABLE',
                    message: 'A required infrastructure dependency is temporarily unavailable.',
                };
            }

            this.logUnexpected(request, exception);
        }

        return {
            status: HttpStatus.INTERNAL_SERVER_ERROR,
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred.',
        };
    }

    private logUnexpected(request: Request, error: Error, dependencyFailure = false): void {
        // Nunca loga corpo da requisição nem mensagem de erro com valores: só tipo e rota.
        this.logger.error(
            JSON.stringify({
                event: 'http_request_failed',
                path: request.url,
                method: request.method,
                errorName: error.name,
                dependencyFailure,
            }),
        );
    }
}
