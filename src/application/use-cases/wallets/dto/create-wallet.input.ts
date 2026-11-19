export interface CreateWalletInput {
    playerId: string;
    currency: string;
    initialBalance: string;
    /**
     * Id definido pelo chamador (opcional). A API HTTP não o expõe: serve para
     * chamadores internos (testes, cargas de dados) que precisam conhecer o id antes.
     */
    walletId?: string;
}
