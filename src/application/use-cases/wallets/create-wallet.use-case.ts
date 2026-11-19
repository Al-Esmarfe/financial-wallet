import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

import { Money } from '../../../domain/money/money.js';
import { Wallet } from '../../../domain/wallets/wallet.js';

import { LedgerEntry } from '../../../domain/ledger/ledger-entry.js';
import { LedgerEntryDirection } from '../../../domain/ledger/ledger-entry-direction.js';

import { WagerTransaction } from '../../../domain/transactions/wager-transaction.js';
import { WagerTransactionType } from '../../../domain/transactions/wager-transaction-type.js';

import type { UnitOfWork } from '../../ports/unit-of-work.js';
import { CreateWalletInput } from './dto/create-wallet.input.js';
import { UNIT_OF_WORK } from '../../ports/tokens.js';
import {
    ApplicationValidationError,
    WalletAlreadyExistsError,
} from '../../errors/application-errors.js';

export interface CreateWalletOutput {
    id: string;
    playerId: string;
    currency: string;
    balance: string;
    version: number;
    createdAt: string;
}

@Injectable()
export class CreateWalletUseCase {
    constructor(
        @Inject(UNIT_OF_WORK)
        private readonly unitOfWork: UnitOfWork,
    ) {}

    async execute(input: CreateWalletInput): Promise<CreateWalletOutput> {
        const initialBalance = Money.create(
            input.initialBalance,
            input.currency,
        );

        if (initialBalance.isLessThan(Money.zero(input.currency))) {
            throw new ApplicationValidationError('Initial balance cannot be negative.');
        }

        return this.unitOfWork.execute(async (repositories) => {
            const alreadyExists =
                await repositories.wallets.existsByPlayerAndCurrency(
                    input.playerId,
                    input.currency,
                );

            if (alreadyExists) {
                throw new WalletAlreadyExistsError();
            }

            const wallet = Wallet.open({
                id: input.walletId ?? randomUUID(),
                playerId: input.playerId,
                initialBalance,
            });

            await repositories.wallets.save(wallet);

            const createdAt = wallet.createdAt.toISOString();

            if (initialBalance.isPositive()) {
                const transactionId = randomUUID();

                const providerId = 'SYSTEM';
                const providerTransactionId = `OPENING:${wallet.id}`;
                const idempotencyKey = `wallet-opening:${wallet.id}`;

                const requestHash = createHash('sha256')
                    .update(
                        JSON.stringify({
                            playerId: input.playerId,
                            walletId: wallet.id,
                            currency: input.currency,
                            initialBalance: initialBalance.toString(),
                            type: WagerTransactionType.OPENING,
                        }),
                    )
                    .digest('hex');

                const transaction = WagerTransaction.create({
                    id: transactionId,
                    providerId,
                    providerTransactionId,
                    playerId: input.playerId,
                    walletId: wallet.id,
                    roundId: 'SYSTEM_OPENING',
                    type: WagerTransactionType.OPENING,
                    amount: initialBalance,
                    idempotencyKey,
                    requestHash,
                    gameId: 'game-123',
                });

                transaction.markProcessed();

                await repositories.transactions.save(transaction);

                const ledgerEntry = LedgerEntry.create({
                    id: randomUUID(),
                    walletId: wallet.id,
                    transactionId: transaction.id,
                    transactionType: WagerTransactionType.OPENING,
                    direction: LedgerEntryDirection.CREDIT,
                    amount: initialBalance,
                    balanceBefore: Money.zero(wallet.currency),
                    balanceAfter: wallet.balance,
                    createdAt,
                    walletVersion: wallet.version,
                });

                await repositories.ledger.save(ledgerEntry);
            }

            return {
                id: wallet.id,
                playerId: wallet.playerId,
                currency: wallet.currency,
                balance: wallet.balance.toString(),
                version: wallet.version,
                createdAt,
            };
        });
    }
}
