# HTTP API

Base URL local: `http://localhost:3000`.

All monetary values are JSON objects with decimal strings:

```json
{ "amount": "25.00", "currency": "BRL" }
```

The API rejects JSON numeric amounts, negative input amounts, scientific notation and more than two fractional digits. `OPENING` is internal and cannot be submitted by a provider.

## Wallets

### `POST /wallets` — 201

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}
```

Returns `id`, `playerId`, `balance` and `version`. A positive opening balance is persisted with its internal OPENING transaction and CREDIT ledger entry in the same SQL unit of work. A duplicate `(playerId, currency)` returns `409 WALLET_ALREADY_EXISTS`.

### `GET /wallets/:walletId` — 200

Returns the wallet, materialized balance, currency, version and timestamps. Unknown IDs return `404 NOT_FOUND`.

### `GET /wallets/:walletId/ledger?cursor=<opaque>&limit=50` — 200

Returns newest-first ledger entries (`items`, each with `walletVersion`) and `nextCursor`. The cursor is Base64URL-encoded and scoped to the wallet. `limit` defaults to 50 and must be between 1 and 100.

### `POST /wallets/:walletId/reconciliation` — 200

Rebuilds the balance from ledger entries ordered by `walletVersion`, validating the before/after chain **and** that versions are contiguous. Returns `storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries` and `ledgerChainValid`. A mismatch is logged and returned; the endpoint never mutates the wallet or ledger.

## Wagering

### `POST /wagering/transactions` — 200 / 202 / 422

Required header:

```http
Idempotency-Key: provider-a:transaction-123
```

Example body:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

A successful response includes `transactionId`, `status`, `balance`, `failureCode` (when rejected) and `idempotentReplay`. `PENDING_REFERENCE` returns `202`; a business rejection returns `422`; a processed operation returns `200`.

The idempotency key is persisted by the application use case. Reusing it with the same canonical business payload returns the original result and balance with `idempotentReplay=true`. Reusing it with a different payload returns `409 IDEMPOTENCY_CONFLICT`. The key itself is excluded from the SHA-256 payload hash.

`REFUND` and `ROLLBACK` require `referenceExternalTransactionId`. The API does not accept `OPENING`.

### `GET /wagering/transactions/:transactionId` — 200

Reads a transaction by internal UUID.

### `GET /providers/:providerId/wagering/transactions/:externalTransactionId` — 200

Reads a transaction by provider identity and external transaction ID.

### Rejected / failure codes

`INSUFFICIENT_FUNDS`, `REFERENCE_NOT_FOUND`, `REFERENCE_EXPIRED`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED`, `REFERENCE_MISMATCH`, `INVALID_TRANSACTION`, `ROLLBACK_INSUFFICIENT_FUNDS`, `INTERNAL_ERROR`.

A `503` response carries `Retry-After` and `retryable: true`.

## Metrics

`GET /metrics` exposes Prometheus text format (per instance).

## Health

- `GET /health/live`: always returns 200 while the HTTP process can answer.
- `GET /health/ready`: checks PostgreSQL and both configured SQS queues (outbound events and inbound commands); returns 503 if a dependency is unavailable or either queue URL is not configured.

## Status codes

| HTTP | Stable code | Meaning |
|---:|---|---|
| 200 | — | Processed transaction or successful query |
| 201 | — | Wallet created |
| 202 | — | Accepted and waiting for reference |
| 400 | `VALIDATION_ERROR` | Invalid contract, money or missing idempotency header |
| 404 | `NOT_FOUND` / `WALLET_NOT_FOUND` | Resource does not exist |
| 409 | `IDEMPOTENCY_CONFLICT` | Key reused with a different business payload |
| 409 | `EXTERNAL_TRANSACTION_CONFLICT` | Provider external ID already exists |
| 409 | `WALLET_ALREADY_EXISTS` | Player already has a wallet in this currency |
| 422 | `BUSINESS_REJECTED` | Transaction rejected; inspect `failureCode` |
| 503 | `SERVICE_UNAVAILABLE` | Database or required infrastructure temporarily unavailable |

## Authentication

Authentication is deliberately deferred as allowed by the challenge. Wallet and wagering controllers have an explicit no-op `ProviderAuthGuard` seam and a `ProviderIdentityPort` contract for a future OIDC/JWT adapter. Health endpoints remain open. Do not expose this no-op configuration to an untrusted network.
