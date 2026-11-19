# Status: enunciado → implementação → evidência

Legenda de evidência: **U** = teste unitário · **I** = integração (PG/SQS reais) · **M** = multi-instância · **E** = e2e HTTP · **DB** = garantido por constraint/trigger.

| Requisito do enunciado | Implementação | Evidência |
|---|---|---|
| Dinheiro decimal string | `Money` (Decimal.js), `numeric(20,2)`, DTO rejeita number | U, DB |
| Wallet / WagerTransaction / Ledger imutável | Domínio + entidades + trigger de imutabilidade e TRUNCATE | U, I, DB |
| InboxMessage / OutboxMessage como entidades | `src/domain/messaging` (transições `markProcessed`, `scheduleRetry`, `isDue`) usadas pelos repositórios e workers | U, I |
| Garantias no schema | CHECK (saldo ≥ 0, `version ≥ 1`, valor > 0, aritmética do ledger), UNIQUE (wallet por player+moeda, idempotência, ID externo, ledger por transação, uma reversão por referência), triggers (imutabilidade, guarda de lost update) | I, DB |
| Migrations versionadas e reversíveis | `src/migrations` (up e down completos, inclusive com dados) | I |
| BET/WIN/LOSS/REFUND/ROLLBACK | `ProcessWagerTransactionUseCase` | U (matriz completa), I, E |
| Idempotência persistente | Uniques + hash SHA-256 canônico | U, I, M, E |
| Concorrência / saldo nunca negativo | `FOR UPDATE` + CHECK + trigger de versão | U, I, M, E |
| Saldo 100 e 2×80 | Cenário dedicado | U, I, M, E |
| Referências fora de ordem | `PENDING_REFERENCE`, retry exponencial, TTL 24 h, evento `WagerTransactionRejected` ao expirar | U, I (PG real, 2 workers concorrentes) |
| Inbox transacional + SQS FIFO | `InboxConsumerWorker`, ack pós-commit | U, I |
| DLQ e classificação de erros | permanente/negócio/transitório, redrive 5 | U, I |
| Outbox transacional | `OutboxPublisherWorker` (SKIP LOCKED, lease, backoff, FAILED estacionado sem descarte) | U, I |
| Atomicidade wallet + ledger + inbox + outbox | Uma `em.transactional`; crash injetado antes do COMMIT não confirma nada | I |
| Crash recovery | antes do commit, pós-commit/pré-ack, publisher antes do `PUBLISHED`, SIGKILL de instância + reinício | I, M |
| Invariante final `saldo == ledger` | `test/support/wallet-invariants.ts` em todos os testes com banco | I, M, E |
| Múltiplas instâncias | Compose `--scale app=3`; teste com 3 processos | M |
| API com status consistentes | Filtro de exceções por categoria; `Retry-After` | U, E |
| Observabilidade | Logs JSON, `/metrics`, `/health/*` | U, E |
| Shutdown cooperativo | Hooks + drenagem de lote + `SqsClientLifecycle` | U |
| Carga (opcional) | `scripts/load-test.ts` (`bun run test:load`); resultados em ARCHITECTURE.md §19 | executado (3 instâncias) |
| Autenticação (opcional) | Seam no-op (`ProviderAuthGuard` + `ProviderIdentityPort`) + desenho OIDC documentado | — |
| Documentação | README, ARCHITECTURE, API, este mapa | — |

## O que foi verificado e como

Tudo abaixo roda localmente com `docker compose up -d postgres localstack` (PostgreSQL 17 e LocalStack reais, sem mocks de infraestrutura):

- `bun run typecheck` e `bun run lint`: sem erros nem avisos.
- `bun run test:all`: **330 testes passando** (unitários, integração com PostgreSQL, integração com PostgreSQL + SQS, 3 processos da API, e2e HTTP). A suíte foi executada várias vezes seguidas sobre o mesmo banco de teste, para garantir que não depende de banco limpo.
- Migrations: `db:migrate` → `db:migrate:down --to 0` → `db:migrate` com dados no banco.
- `bun run test:load` contra 3 instâncias: 0% de erro e 20/20 wallets reconciliadas (números em ARCHITECTURE.md §19).
