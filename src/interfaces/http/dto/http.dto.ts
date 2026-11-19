import { BadRequestException } from '@nestjs/common';
import { ApplicationValidationError } from '../../../application/errors/application-errors.js';
import {
    assertPlainObject,
    requireMoney,
    requireString,
    requireUuid,
    validateWagerCommand,
    type WagerCommand,
    type WagerCommandMoney,
} from '../../../application/validation/wager-command.validation.js';

/**
 * Adaptador HTTP da validação de entrada. A lógica vive na camada de aplicação
 * (compartilhada com o consumer SQS); aqui só convertemos o erro de validação
 * em 400 Bad Request.
 */
export type MoneyHttpDto = WagerCommandMoney;
export type SubmitWagerHttpDto = WagerCommand;

export interface CreateWalletHttpDto {
    playerId: string;
    initialBalance: MoneyHttpDto;
}

function asBadRequest<T>(operation: () => T): T {
    try {
        return operation();
    } catch (error) {
        if (error instanceof ApplicationValidationError) {
            throw new BadRequestException(error.message);
        }
        throw error;
    }
}

export function assertObject(value: unknown, field = 'body'): asserts value is Record<string, unknown> {
    asBadRequest(() => assertPlainObject(value, field));
}

export function requiredString(value: unknown, field: string, max = 150): string {
    return asBadRequest(() => requireString(value, field, max));
}

export function requiredUuid(value: unknown, field: string): string {
    return asBadRequest(() => requireUuid(value, field));
}

export function parseMoney(value: unknown, field = 'money'): MoneyHttpDto {
    return asBadRequest(() => requireMoney(value, field));
}

export function parseCreateWallet(value: unknown): CreateWalletHttpDto {
    return asBadRequest(() => {
        assertPlainObject(value, 'body');
        return {
            playerId: requireString(value.playerId, 'playerId', 128),
            initialBalance: requireMoney(value.initialBalance, 'initialBalance'),
        };
    });
}

export function parseSubmitWager(value: unknown): SubmitWagerHttpDto {
    return asBadRequest(() => validateWagerCommand(value));
}
