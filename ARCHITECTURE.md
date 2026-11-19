# ARCHITECTURE.md — decisões arquiteturais

Este documento explica **o que** foi construído, **por que** e **o que foi descartado**. Cada seção termina com o trade-off assumido.

## 1. Objetivo e princípios

Processar operações de aposta de provedores externos (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de forma **correta sob concorrência, retries, duplicatas, falhas parciais e múltiplas instâncias**.

Princípios que guiam tudo:

1. **O banco é a autoridade.** Corretude não depende de memória, de afinidade de instância nem da ordem do broker. Constraints e triggers são a última linha de defesa; o código é a primeira.
2. **Uma regra de negócio, dois canais.** HTTP e SQS chamam o mesmo `ProcessWagerTransactionUseCase` com a mesma validação.
3. **Tudo que precisa ser atômico está na mesma transação SQL.** Sem "dual write".
4. **Falhas são classificadas**, não tratadas por `catch` genérico.

## 2. Stack

Bun 1.x · TypeScript strict · NestJS · PostgreSQL 17 · MikroORM 7 · Decimal.js · AWS SDK v3 + SQS FIFO (LocalStack) · Docker Compose.

### 2.1 Por que MikroORM (e não TypeORM)

| Critério | MikroORM | TypeORM |
|---|---|---|
| Transação explícita | `em.transactional(cb)` com `EntityManager` *forkado* por transação: o contexto não vaza entre requisições concorrentes | `DataSource.transaction` funciona, mas o padrão comum (repositórios globais) facilita usar sem querer a conexão errada fora da transação |
| Unit of Work / Identity Map | Nativos e explícitos: uma entidade por id dentro da transação, `flush` controlado | Não há Unit of Work de verdade; `save` vai ao banco na hora |
| Locks | `LockMode.PESSIMISTIC_WRITE` (`FOR UPDATE`) e `PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`) de primeira classe | `setLock('pessimistic_write')` + `skip_locked` via opção, menos uniforme |
| Decimal | `type: 'decimal'` volta como **string**, sem conversão para `number` | Também string, mas fácil de mapear errado com `transformer` |
| SQL cru quando precisa | `em.getConnection().execute(sql, params, 'all', tx)` participa da MESMA transação | Possível com `queryRunner`, mais cerimonioso |

**Como foi usado.** As entidades do ORM (`src/infrastructure/database/entities`) são só mapeamento de tabela; os repositórios convertem para o domínio via `rehydrate` (o domínio não conhece o ORM). As entidades **não declaram relações** (`walletId` é um `uuid` simples), de propósito: carregar o agregado nunca dispara *lazy loading* nem cascata. A consequência é que o MikroORM não conhece a ordem de dependência das tabelas; por isso os repositórios fazem `flush` logo após inserir uma linha que outras referenciam (wallet, transação), e o ledger é gravado depois. SQL cru é usado onde o ORM atrapalharia: o *claim* do outbox (CTE + `SKIP LOCKED` + `UPDATE … RETURNING`) e o `INSERT … ON CONFLICT DO NOTHING` da Inbox.

**Mapeamento do Money.** Colunas separadas `amount numeric(20,2)` + `currency char(3)`. O driver devolve `numeric` como string (`"25.00"`), que vira `Money.create(amount, currency)` na reidratação; na gravação, `Money.toString()` (escala fixa 2). Nenhum `number` toca valor monetário em nenhum ponto.

**Estratégia transacional.** Cada caso de uso roda em UMA `em.transactional` (isolamento READ COMMITTED, o padrão do PostgreSQL). READ COMMITTED basta porque o conflito real é sempre uma linha conhecida (a wallet, ou a transação referenciada), protegida por `FOR UPDATE`; não precisamos de `SERIALIZABLE` global (ver §5).

## 3. Camadas

```
domain  ←  application  ←  infrastructure / interfaces
```

`domain` (Money, Wallet, WagerTransaction, LedgerEntry, InboxMessage, OutboxMessage, erros) não importa NestJS, MikroORM nem AWS. `application` define casos de uso, portas (`UnitOfWork`, repositórios) e workers. `infrastructure` implementa as portas. Isso permitiu testar a **matriz completa de regras de negócio sem banco**, com um `InMemoryUnitOfWork` que imita rollback e violações de unicidade.

*Trade-off:* mais arquivos e indireção em troca de testabilidade e de poder trocar o ORM.

## 4. Dinheiro

`Money` (Decimal.js) com escala fixa de 2 casas; banco `numeric(20,2)`; JSON sempre `{ "amount": "25.00", "currency": "BRL" }`. A validação rejeita número JSON, notação científica, negativos e mais de 2 casas. Operações exigem moedas iguais.

*Por quê:* `0.1 + 0.2 !== 0.3` em ponto flutuante; em finanças isso é bug de dinheiro real.

## 5. Concorrência: lock pessimista por carteira

Estratégia: `SELECT … FOR UPDATE` na linha da carteira dentro da transação. A unidade de concorrência é `walletId`; carteiras diferentes **não** se bloqueiam. Como o lock é do PostgreSQL, vale entre processos.

Defesas em profundidade no banco:

- `CHECK (balance >= 0)`.
- Trigger `enforce_wallet_update_rules`: `player_id` e `currency` imutáveis; **toda mudança de saldo exige `version + 1`** e toda mudança de versão exige mudança de saldo; violação levanta `40001` (serialization failure). Se alguém esquecer o lock, o *lost update* **falha alto** em vez de corromper silenciosamente.
- `UNIQUE (wallet_id, wallet_version)` no ledger.

Cenário obrigatório: saldo 100,00 e duas apostas de 80,00 simultâneas → a segunda espera o lock, lê saldo 20,00, é `REJECTED/INSUFFICIENT_FUNDS`.

**Alternativas descartadas**

| Alternativa | Por que não |
|---|---|
| Lock otimista (version + retry) | Sob contenção na mesma carteira (caso comum em jogos) gera tempestade de retries; o lock pessimista serializa de forma previsível |
| Lock em memória / mutex por carteira | Só funciona numa instância; quebra com 2+ |
| `SERIALIZABLE` global | Custo e taxa de aborts maiores sem ganho, já que a unidade de conflito é uma linha |
| Advisory locks | Funcionariam, mas `FOR UPDATE` já é o lock da própria linha que vamos alterar |

*Trade-off:* a mesma carteira processa uma operação por vez (throughput por carteira limitado pela duração da transação, que é curta).

## 6. Idempotência persistente

Duas identidades únicas por provedor: `(provider_id, idempotency_key)` e `(provider_id, provider_transaction_id)`.

**Hash do payload:** `sha256( JSON canônico )` sobre os campos de negócio — chaves ordenadas recursivamente, `amount` normalizado para 2 casas, `idempotencyKey` **fora** do hash (ela é a chave de busca, não conteúdo).

Decisão de resultado ao reencontrar a chave:

| Situação | Resultado |
|---|---|
| Mesma chave, mesmo hash | Retorna o resultado original (`idempotentReplay: true`) |
| Mesma chave, hash diferente | `409 IDEMPOTENCY_CONFLICT` |
| Mesmo ID externo, chave diferente | `409 EXTERNAL_TRANSACTION_CONFLICT` |

Sob corrida (50 requisições idênticas), perde quem violar a unique: o perdedor captura `23505`, relê o vencedor e responde como replay. Só um efeito financeiro existe.

*Por quê no banco:* um cache em memória some no restart e não vale entre instâncias.

## 7. Ledger e ordem canônica

Cada movimento efetivo gera um `LedgerEntry` imutável com direção, valor, saldo antes/depois e **`wallet_version`**. `LOSS` não movimenta saldo; rejeição não gera ledger.

**Por que `wallet_version`:** ordenar por `created_at` é ambíguo (relógio, empates entre instâncias). A versão é incrementada sob o lock, então é uma ordem total e sem buracos por carteira. A reconciliação (`POST /wallets/:id/reconciliation`) verifica três coisas: cadeia `antes → depois`, **continuidade** das versões e igualdade entre saldo materializado e reconstruído. Divergência é retornada, logada e contada em métrica; **nunca corrigida automaticamente**.

Imutabilidade: trigger bloqueia `UPDATE`/`DELETE` e `TRUNCATE`.

## 8. Regras de negócio

| Tipo | Efeito |
|---|---|
| `BET` | Débito; recusa por saldo insuficiente |
| `WIN` | Crédito (não exige referência) |
| `LOSS` | Sem movimento de saldo; registra o resultado |
| `REFUND` | Exige `referenceExternalTransactionId` de uma **`BET` processada**; credita o valor de volta |
| `ROLLBACK` | Exige referência a uma `BET`, `WIN` ou `REFUND` **processada**; desfaz o efeito (se desfazer um crédito e o saldo não cobrir → `ROLLBACK_INSUFFICIENT_FUNDS`) |

A reversão deve **bater com a referência** (mesmo provedor, jogador, carteira, rodada, moeda e valor); caso contrário `REFERENCE_MISMATCH`.

Interpretação adotada (documentada por ser ambígua): **uma reversão por referência** — depois de um `REFUND` ou `ROLLBACK` processado, outro sobre a mesma referência é `REFERENCE_ALREADY_REVERSED`. Referência de outra carteira/jogador → `REFERENCE_MISMATCH`.

### 8.1 Taxonomia de `failureCode` (seção 7.2)

Toda rejeição carrega um `failureCode` estável (o domínio exige o código em `WagerTransaction.reject`). O provedor decide pelo código, nunca pela mensagem:

| `failureCode` | Quando | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` sem saldo | Desistir da aposta (não reenviar igual) |
| `ROLLBACK_INSUFFICIENT_FUNDS` | `ROLLBACK` de um crédito (WIN/REFUND) que deixaria o saldo negativo | Escalar para conciliação manual: é situação operacional diferente de aposta sem saldo |
| `REFERENCE_EXPIRED` | Referência não chegou dentro do TTL de 24 h | Verificar se a transação referenciada existe no provedor; reenviar com **nova** chave se for o caso |
| `REFERENCE_NOT_PROCESSED` | Referência existe mas não está `PROCESSED` (ex.: a BET foi rejeitada) | Desistir: não há o que reverter |
| `REFERENCE_ALREADY_REVERSED` | A referência já tem um REFUND/ROLLBACK aplicado | Desistir: a reversão já ocorreu |
| `REFERENCE_MISMATCH` | Tipo de referência inválido (REFUND só de BET; ROLLBACK de BET/WIN/REFUND) ou provider/player/wallet/rodada/moeda/valor diferentes | Corrigir o payload |
| `INVALID_TRANSACTION` | Transação pendente cuja wallet sumiu ou não pertence ao player/moeda | Corrigir o payload |
| `INTERNAL_ERROR` | Padrão de `fail()` (status `FAILED`) | Abrir incidente |
| `REFERENCE_NOT_FOUND` | **Reservado, não emitido hoje**: referência ausente nunca é rejeitada na hora, vira `PENDING_REFERENCE` e, no fim do TTL, `REFERENCE_EXPIRED` | — |

Erros que **não** geram transação persistida (payload inválido, wallet inexistente, conflito de idempotência) são respondidos só pelo status HTTP e pelo `code` do corpo (§13).

### 8.2 Transições de estado

**`WagerTransaction`** (nasce `PENDING` em `create`; `rehydrate` não revalida transições):

```
                 ┌──────────────► PROCESSED   (terminal)
                 │
PENDING ─────────┼──────────────► REJECTED    (terminal; sempre com failureCode)
   │             │
   │             └──────────────► FAILED      (terminal; erro permanente, auditável)
   │
   └──► PENDING_REFERENCE ──┬───► PROCESSED   (referência chegou e é válida)
          (REFUND/ROLLBACK) ├───► REJECTED    (referência inválida, já revertida ou TTL vencido)
                            └───► (permanece; o worker reagenda com backoff)
```

| De | Para | Método | Condição |
|---|---|---|---|
| `PENDING` | `PROCESSED` | `markProcessed(at)` | Regras atendidas; saldo/ledger aplicados na mesma transação |
| `PENDING` | `REJECTED` | `reject(reason, code)` | Regra de negócio violada |
| `PENDING` | `PENDING_REFERENCE` | `markPendingReference()` | REFUND/ROLLBACK sem a referência |
| `PENDING_REFERENCE` | `PROCESSED` / `REJECTED` | idem acima | Pelo `ReferenceRetryWorker` |
| `PENDING`/`PENDING_REFERENCE` | `FAILED` | `fail(reason, code)` | Erro permanente de infraestrutura. Hoje nenhum fluxo o emite: erros de infraestrutura são **transitórios** por padrão (retry seguro porque tudo é idempotente) |
| `PROCESSED`/`REJECTED`/`FAILED` | qualquer | — | **Proibido**: `InvalidTransactionStateError` (erro de programação) no domínio **e** trigger `prevent_terminal_transaction_mutation` no banco |

**`InboxMessage`**: `RECEIVED → PROCESSING → PROCESSED` (sucesso) · `→ FAILED` (transitório; volta a `PROCESSING` na reentrega) · `→ REJECTED` (recusa de negócio, terminal) · `→ DEAD_LETTERED` (terminal). `PROCESSED` nunca é rebaixado.

**`OutboxMessage`**: `PENDING → PROCESSING → PUBLISHED` (terminal) · falha → `PENDING` com `next_attempt_at` (backoff) · ao esgotar `OUTBOX_MAX_ATTEMPTS` → `FAILED` *estacionado* (ver §11). A transição de retry é `OutboxMessage.scheduleRetry`.

## 9. Referências fora de ordem

`REFUND`/`ROLLBACK` que chegam antes da `BET` ficam `PENDING_REFERENCE` (HTTP 202) e publicam `WagerTransactionPendingReference`. Um worker reprocessa com backoff exponencial (5 s, dobrando até 15 min) e **TTL de 24 h**; vencido, vira `REJECTED/REFERENCE_EXPIRED` e publica `WagerTransactionRejected` (na mesma transação). O worker usa `FOR UPDATE SKIP LOCKED`, então várias instâncias não reprocessam a mesma linha.

*Por que 24 h:* a referência que chega fora de ordem normalmente aparece em segundos (reordenação do broker) ou minutos (retry do provedor). 24 h cobre indisponibilidades longas do lado do provedor e uma janela de operação de um dia útil, sem deixar créditos "pendurados" indefinidamente. Com o teto de 15 min, são ~100 tentativas no pior caso: custo desprezível. Ambos são configuráveis em `ReferenceRetryPolicy`.

*Por quê não exigir ordem:* o enunciado diz explicitamente que não se pode presumir. FIFO por `MessageGroupId=walletId` ajuda, mas não é a garantia — a garantia é o desenho tolerante.

## 10. Inbox transacional (entrada SQS)

Fluxo de uma mensagem:

1. Parse do envelope (`messageId`, `type`, `occurredAt`, `data`). Inválido → **DLQ imediata**.
2. Dentro de **uma transação**: registra Inbox (`UNIQUE (consumer_name, message_id)`) → trava carteira → saldo + ledger + transação + outbox → marca Inbox `PROCESSED`.
3. **Só depois do commit**: `DeleteMessage` no SQS.

Se o processo morrer entre 2 e 3, o SQS reentrega; a Inbox já está `PROCESSED`, a mensagem vira duplicata e é apenas confirmada. Mesmo `messageId` com **payload diferente** → `INBOX_PAYLOAD_MISMATCH` (não reaplica).

### Classificação de falhas

| Classe | Exemplos | Ação |
|---|---|---|
| PERMANENT | JSON inválido, campo ausente, moeda inválida | Envia à DLQ de aplicação (com motivo), registra na Inbox, só então apaga o original |
| BUSINESS_TERMINAL | Saldo insuficiente, carteira inexistente, conflito | Ack; resultado auditável na Inbox/transação |
| TRANSIENT | Postgres fora, timeout, deadlock, erro desconhecido | Não confirma; `ChangeMessageVisibility` com backoff 2, 4, 8… s; no limite de recebimentos → DLQ |

Erro desconhecido é transitório de propósito: como o processamento é idempotente, tentar de novo é seguro, e o limite de recebimentos impede laço infinito. Além disso, a fila tem *redrive* nativo (`maxReceiveCount=5`) como rede de segurança.

## 11. Outbox transacional (saída)

Eventos (`WagerTransactionProcessed`, `…Rejected`, `…PendingReference`, `WalletBalanceChanged`) são gravados **na mesma transação** da mudança de estado. `WalletBalanceChanged` só é emitido quando o saldo de fato muda.

Publisher: reivindica linhas com `FOR UPDATE SKIP LOCKED` (instâncias pegam lotes disjuntos), com **lease de 2 min**; publica em ordem por agregado e em paralelo entre agregados; sucesso → `PUBLISHED`; falha → `OutboxMessage.scheduleRetry` (backoff exponencial com jitter). Ao esgotar `OUTBOX_MAX_ATTEMPTS` (10) o evento vira `FAILED` **estacionado**: continua sendo tentado a cada `OUTBOX_BACKOFF_CAP_MS` (60 s) e dispara o alerta (`outbox_failed_events > 0`). Ele **nunca é descartado**: o evento já foi confirmado junto com a transação financeira, e descartá-lo violaria "não perder eventos confirmados". Entrega **at-least-once**: se o publisher morrer após enviar e antes de marcar `PUBLISHED`, outra instância reenvia — e o FIFO deduplica por `MessageDeduplicationId = eventId` (janela de 5 min); consumidores devem ser idempotentes por `eventId` de qualquer forma.

*Trade-off:* *exactly-once* de ponta a ponta não existe; escolhemos at-least-once + dedupe, que é o padrão defensável.

## 12. Filas

| Fila | Sentido | DLQ |
|---|---|---|
| `wager-transactions.fifo` | provedor → serviço | `wager-transactions-dlq.fifo` |
| `wager-events.fifo` | serviço → consumidores | `wager-events-dlq.fifo` |

`MessageGroupId = walletId` (ordem por carteira, paralelismo entre carteiras). `maxReceiveCount=5`, visibilidade 60 s.

Entrada e saída são **filas diferentes** de propósito: se o outbox publicasse na fila de comandos, o serviço consumiria os próprios eventos (e os mandaria à DLQ como malformados). `validateMessagingConfig` derruba a inicialização se `SQS_WAGER_EVENTS_QUEUE_URL == SQS_WAGER_TRANSACTIONS_QUEUE_URL` ou se as variáveis antigas e ambíguas (`SQS_WAGER_QUEUE_URL`, `SQS_WAGER_DLQ_URL`) estiverem definidas.

## 13. API e códigos HTTP

`Idempotency-Key` obrigatório. Mapeamento consistente por **categoria de erro**: validação 400, não encontrado 404, conflito 409, recusa de negócio 422, aceito-pendente 202, infraestrutura 503 com `Retry-After`. O corpo de erro traz `code`, `message` e `retryable`. O filtro de exceções é baseado em `instanceof` de erros tipados (não em comparação de string de mensagem).

## 14. Observabilidade

- Logs JSON estruturados com contexto por `AsyncLocalStorage` (`correlationId`, `messageId`, `walletId`, `transactionId`); chaves sensíveis (saldo, valores, payload) são redigidas.
- Métricas Prometheus implementadas in-house em `/metrics` (zero dependência nova): contadores de transações/duplicatas/conflitos/DLQ/retries, histogramas de latência e de espera de lock, gauges de outbox (pendentes, falhos, lag).
- Health: `live` e `ready` (Postgres + filas).

## 15. Shutdown cooperativo

`SIGTERM` → o consumer para de receber, aguarda o lote em andamento e devolve mensagens ainda não iniciadas (`VisibilityTimeout=0`); o publisher termina o ciclo e libera linhas não tentadas; o worker de referência aguarda seu lote; por fim o cliente SQS é fechado (`SqsClientLifecycle`). Nenhuma transação é interrompida no meio.

## 16. Autenticação

**Decisão:** não implementada nesta entrega, conforme permitido pelo enunciado (não pontua e competiria com correção financeira, concorrência e idempotência). O ponto de extensão está no código: `ProviderAuthGuard` (no-op, aplicado em `WalletsController` e `WageringController`) e a porta `ProviderIdentityPort` (`src/application/ports/auth`). **Não expor publicamente** sem o adaptador real.

**Desenho que seria adotado:**

1. **IdP externo:** Keycloak no Docker Compose, realm `wallet`, **um client confidencial por provedor de jogos** (`provider-a`, `provider-b`…) com o fluxo **OAuth2 Client Credentials** (máquina-a-máquina; não há usuário humano). Nenhuma tabela de usuários ou senhas no serviço.
2. **Token:** JWT de vida curta (5 min) com claim `provider_id` (mapper do client) e `aud = wallet-api`.
3. **Validação no serviço:** um `OidcProviderIdentityAdapter` implementa `ProviderIdentityPort`: valida assinatura via **JWKS** do realm (cache com rotação de chaves), `iss`, `aud`, `exp`. O `ProviderAuthGuard` passa a chamar a porta e anexa `ProviderIdentity { providerId, subject }` à requisição.
4. **Autorização:** o `providerId` do token deve ser igual ao `providerId` do corpo (`POST /wagering/transactions`) e ao do path (`GET /providers/:providerId/...`); divergência → `403` *antes* de qualquer efeito, sem consumir a idempotency key. Consultas de wallet/ledger exigiriam um papel administrativo (`wallet:read`).
5. **Fora do escopo da autenticação:** `/health/*` e `/metrics` ficam abertos (rede interna). Mensagens SQS são canal interno confiável (IAM da fila), mas o `providerId` da mensagem continua sujeito às mesmas validações de domínio: idempotência por provedor, referência do mesmo provedor e posse da wallet pelo player.

Trocar o adaptador não toca domínio nem casos de uso.

## 17. Estratégia de testes

| Nível | O que prova |
|---|---|
| Unitário | Domínio (Money, Wallet, WagerTransaction, Ledger, Inbox/OutboxMessage), matriz completa de regras, 2×80 em 100, 50 paralelas idempotentes (via `InMemoryUnitOfWork`), workers, classificação de erro, hash canônico, filtro HTTP, métricas, logger |
| Integração (PG real) | Migrations sobem e descem; constraints e triggers (saldo ≥ 0, `version ≥ 1`, unicidades, uma reversão por referência, imutabilidade, guarda de lost update); atomicidade wallet + transação + ledger + inbox + outbox com crash imediatamente antes do COMMIT; concorrência com clientes independentes; **REFUND/ROLLBACK antes da referência** resolvidos pelo worker (inclusive com 2 workers disputando) e expirados no TTL |
| Integração (PG + SQS real) | Inbox/Outbox, crash pós-commit/pré-ack, crash do publisher, 2 publishers (SKIP LOCKED), poison → DLQ, redrive, payload divergente |
| Multi-instância | 3 processos da API: 30 requisições com a mesma chave, corrida de saldo, wallets em paralelo, **SIGKILL de uma instância com requisições em andamento + reinício na mesma porta + retry** com consistência final comprovada |
| E2E HTTP | Contrato de status codes e reconciliação |
| Carga (opcional) | §19 |

**Invariante final em todos os testes com banco:** `test/support/wallet-invariants.ts` reconstrói o saldo **a partir de zero** pelo ledger (ordem `wallet_version`), valida a cadeia `balance_before → balance_after`, a contiguidade das versões e compara com `wallets.balance`. As wallets de teste são abertas pelo mesmo caso de uso da API (OPENING + CREDIT), então o invariante vale desde o primeiro instante.

## 18. Limitações e evolução

- Auth real, rate limiting por provedor.
- Métricas por instância (agregação fica a cargo do Prometheus).
- Particionamento do ledger / arquivamento para volumes muito altos.
- *Hot wallet* (uma carteira muito disputada) é limitada pela serialização; mitigável com batching por carteira.
- Um *relay* CDC (Debezium) poderia substituir o polling do outbox se a latência exigir.
- Evento estacionado em `FAILED` não bloqueia os eventos seguintes do mesmo agregado; consumidores devem ordenar `WalletBalanceChanged` por `walletVersion` (campo presente no payload), não pela ordem de chegada.
- `REFERENCE_NOT_FOUND` e `fail()`/`FAILED` existem no modelo mas nenhum fluxo os emite hoje (§8.1, §8.2).
- O `down` da migration `20261119173000` não recria o antigo índice único do outbox quando os dados o violam (ele era um bug); avisa via `RAISE NOTICE` e segue, então o rollback completo funciona com dados.

## 19. Teste de carga (`bun run test:load`)

**Ambiente:** notebook Windows 11, Intel Core i5-13420H (12 threads), 24 GB RAM; Docker Desktop (12 CPUs, ~11,5 GB) com PostgreSQL 17.9 e LocalStack (SQS); Bun 1.4.5. **3 instâncias** da API (`bun src/main.ts`, portas 3301–3303) no host, mesmo banco, todos os workers ativos (inbox, outbox, referências). Gerador de carga na mesma máquina (compete por CPU: os números são um piso, não um teto).

**Metodologia:** 20 wallets com saldo alto; 2.000 BETs de 1,00 com 50 requisições simultâneas, round-robin entre as 3 instâncias; 10% das requisições são reenviadas com a mesma `Idempotency-Key` (retry idempotente). Duas rodadas: com 20% da carga numa única wallet "quente" (`LOAD_HOT_RATIO=0.2`, padrão) e sem wallet quente (`LOAD_HOT_RATIO=0`). Ao fim: lag do outbox, tempo para drenar e reconciliação de todas as wallets.

| Rodada | Req. | Throughput | p50 | p95 | p99 | Erros | Conflitos de lock | Replays | Outbox ao fim | Reconciliação |
|---|---|---|---|---|---|---|---|---|---|---|
| Wallet quente 20% | 2.187 | 246 req/s | 127 ms | 618 ms | 903 ms | 0,00% | 0 | 187 | 2.226 pendentes, lag 4,9 s, drenado em 8,7 s | 20/20 |
| Sem wallet quente | 2.207 | 331 req/s | 139 ms | 274 ms | 356 ms | 0,00% | 0 | 207 | 2.749 pendentes, lag 4,0 s, drenado em 8,6 s | 20/20 |

**Análise:**
- **A wallet quente é o gargalo esperado.** Com 20% da carga numa wallet, p95 e p99 mais que dobram (274 → 618 ms; 356 → 903 ms) e o throughput cai ~25%: as transações da mesma wallet são serializadas pelo `FOR UPDATE`, por desenho (§5). As demais wallets não são afetadas: a mediana praticamente não muda.
- **"0 conflitos de lock"** significa que nenhuma transação abortou por deadlock/serialização (`40P01`/`40001`): o lock pessimista faz as concorrentes *esperarem*, não falharem. O custo aparece como latência (`wallet_lock_wait_seconds`), não como erro.
- **Outbox:** o publisher, que sonda a cada 1 s em lotes de 25 por instância, fica atrás da taxa de escrita durante o pico (lag de ~4–5 s) e drena o backlog em ~9 s depois que a carga para. Para manter o lag baixo sob carga contínua: lote maior (`OUTBOX_PUBLISH_BATCH_SIZE`), `SendMessageBatch` (10 mensagens por chamada) ou CDC.
- **Idempotência sob carga:** todos os replays responderam 200 com `idempotentReplay`, e a reconciliação confirmou que nenhum débito foi duplicado.
- **Limites da medição:** uma máquina só (gerador, API, banco e LocalStack competem por CPU); LocalStack não reproduz a latência do SQS real; a rodada é curta (~7–9 s), sem medir degradação ao longo do tempo.
