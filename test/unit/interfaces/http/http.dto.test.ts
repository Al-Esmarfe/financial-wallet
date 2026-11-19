import { describe, expect, it } from 'bun:test';
import { parseCreateWallet, parseSubmitWager } from '../../../../src/interfaces/http/dto/http.dto.js';

describe('HTTP DTO validation', () => {
    it('accepts decimal string money without converting it to number', () => {
        expect(parseCreateWallet({ playerId: 'player-1', initialBalance: { amount: '125.50', currency: 'BRL' } })).toEqual({
            playerId: 'player-1', initialBalance: { amount: '125.50', currency: 'BRL' },
        });
    });

    it('rejects scientific notation, negative values and numeric money', () => {
        for (const amount of ['1e2', '-1.00', 10, '1.234', '']) {
            expect(() => parseCreateWallet({ playerId: 'p1', initialBalance: { amount, currency: 'BRL' } })).toThrow();
        }
    });

    it('rejects OPENING from public wagering contracts', () => {
        expect(() => parseSubmitWager({
            providerId: 'provider', externalTransactionId: 'tx', playerId: 'player', walletId: 'wallet',
            roundId: 'round', gameId: 'game', kind: 'OPENING', money: { amount: '1.00', currency: 'BRL' },
        })).toThrow('OPENING is internal');
    });

    it('requires references for REFUND and ROLLBACK', () => {
        expect(() => parseSubmitWager({
            providerId: 'provider', externalTransactionId: 'tx', playerId: 'player', walletId: 'wallet',
            roundId: 'round', gameId: 'game', kind: 'REFUND', money: { amount: '1.00', currency: 'BRL' },
        })).toThrow('requires referenceExternalTransactionId');
    });
});
