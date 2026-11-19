
import { Wallet } from '../../domain/wallets/wallet.js';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;

  findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null>;

  /**
   * Busca uma wallet aplicando bloqueio pessimista de escrita.
   * Deve ser executado dentro de uma transação SQL.
   */
  findByIdForUpdate(id: string): Promise<Wallet | null>;

  save(wallet: Wallet): Promise<void>;

  existsByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<boolean>;
}
