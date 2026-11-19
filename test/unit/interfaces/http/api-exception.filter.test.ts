import { describe, expect, it } from 'bun:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ApiExceptionFilter } from '../../../../src/interfaces/http/filters/api-exception.filter.js';
import {
    ApplicationValidationError,
    ExternalTransactionConflictError,
    IdempotencyConflictError,
    WalletAlreadyExistsError,
    WalletNotFoundError,
    WalletOwnershipMismatchError,
} from '../../../../src/application/errors/application-errors.js';
import {
    CurrencyMismatchError,
    InsufficientFundsError,
    InvalidMoneyError,
    InvariantViolationError,
} from '../../../../src/domain/errors/domain-errors.js';

function run(exception: unknown) {
    const headers: Record<string, string> = {};
    let status = 0;
    let body: Record<string, any> = {};
    const response = {
        setHeader: (k: string, v: string) => (headers[k] = v),
        status(code: number) { status = code; return this; },
        json(payload: Record<string, any>) { body = payload; },
    };
    const host = {
        switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ url: '/wagering/transactions', method: 'POST' }) }),
    };
    new ApiExceptionFilter().catch(exception, host as never);
    return { status, body, headers };
}

describe('ApiExceptionFilter — one consistent contract for every endpoint', () => {
    it.each([
        ['invalid payload', new ApplicationValidationError('bad'), 400, 'VALIDATION_ERROR', false],
        ['HTTP validation', new BadRequestException('bad'), 400, 'VALIDATION_ERROR', false],
        ['invalid money', new InvalidMoneyError('bad'), 400, 'VALIDATION_ERROR', false],
        ['unknown wallet', new WalletNotFoundError('w'), 404, 'WALLET_NOT_FOUND', false],
        ['HTTP not found', new NotFoundException('x'), 404, 'NOT_FOUND', false],
        ['idempotency conflict', new IdempotencyConflictError(), 409, 'IDEMPOTENCY_CONFLICT', false],
        ['external id reused', new ExternalTransactionConflictError(), 409, 'EXTERNAL_TRANSACTION_CONFLICT', false],
        ['duplicate wallet', new WalletAlreadyExistsError(), 409, 'WALLET_ALREADY_EXISTS', false],
        ['wallet unique race (23505)', Object.assign(new Error('dup'), { code: '23505' }), 409, 'WALLET_ALREADY_EXISTS', false],
        ['ownership mismatch (business)', new WalletOwnershipMismatchError(), 422, 'WALLET_OWNERSHIP_MISMATCH', false],
        ['currency mismatch (business)', new CurrencyMismatchError('x'), 422, 'CURRENCY_MISMATCH', false],
        ['insufficient funds (business)', new InsufficientFundsError(), 422, 'INSUFFICIENT_FUNDS', false],
        ['PostgreSQL unreachable', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 503, 'SERVICE_UNAVAILABLE', true],
        ['deadlock', Object.assign(new Error('deadlock'), { code: '40P01' }), 503, 'SERVICE_UNAVAILABLE', true],
        ['pool timeout', new Error('timeout exceeded when trying to connect'), 503, 'SERVICE_UNAVAILABLE', true],
        ['invariant violated (our bug)', new InvariantViolationError('bug'), 500, 'INTERNAL_ERROR', true],
        ['unknown', new Error('who knows'), 500, 'INTERNAL_ERROR', true],
    ])('%s → %p', (_label, error, status, code, retryable) => {
        const result = run(error);

        expect(result.status).toBe(status as number);
        expect(result.body.code).toBe(code as string);
        expect(result.body.retryable).toBe(retryable as boolean);
        expect(result.body.path).toBe('/wagering/transactions');
    });

    it('sends Retry-After with 503 only', () => {
        expect(run(new Error('connect ECONNREFUSED')).headers['Retry-After']).toBeUndefined(); // 500, não 503
        expect(run(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).headers['Retry-After']).toBe('1');
    });

    it('never leaks internal error messages on 500', () => {
        const result = run(new Error('SELECT * FROM secret_table failed'));
        expect(result.body.message).toBe('An unexpected error occurred.');
    });

    it('gives the five provider-relevant situations five distinct statuses', () => {
        const statuses = new Set([
            run(new ApplicationValidationError('x')).status, // payload inválido
            run(new IdempotencyConflictError()).status, // conflito de idempotência
            run(new WalletOwnershipMismatchError()).status, // rejeição de negócio
            run(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).status, // transitória
        ]);
        expect(statuses).toEqual(new Set([400, 409, 422, 503]));
        // "aceite com processamento pendente" é 202 (não é erro): ver WageringController.
    });
});
