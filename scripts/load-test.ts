/**
 * Teste de carga (opcional): `bun run test:load`
 *
 * Variáveis:
 *   LOAD_BASE_URLS    URLs separadas por vírgula (round-robin)   default http://localhost:3000
 *   LOAD_WALLETS      nº de carteiras                             default 20
 *   LOAD_REQUESTS     nº total de requisições BET                 default 2000
 *   LOAD_CONCURRENCY  requisições em voo                          default 50
 *   LOAD_HOT_RATIO    fração (0-1) enviada a UMA carteira "quente" default 0.2
 *   LOAD_DUP_RATIO    fração (0-1) reenviada com a mesma chave     default 0.1
 *
 * Imprime p50/p95/p99, throughput, taxa de erro, e lê de /metrics: conflitos de lock
 * e lag do outbox. No fim, reconcilia todas as carteiras. Nada aqui é hardcoded:
 * os números são sempre medidos na sua máquina.
 */
import { randomUUID } from "node:crypto";

const bases = (process.env.LOAD_BASE_URLS ?? "http://localhost:3000").split(",").map((s) => s.trim());
const WALLETS = Number(process.env.LOAD_WALLETS ?? 20);
const REQUESTS = Number(process.env.LOAD_REQUESTS ?? 2000);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 50);
const HOT = Number(process.env.LOAD_HOT_RATIO ?? 0.2);
const DUP = Number(process.env.LOAD_DUP_RATIO ?? 0.1);

let rr = 0;
const base = () => bases[rr++ % bases.length]!;

async function call(path: string, body: unknown, key?: string) {
  const started = performance.now();
  try {
    const res = await fetch(base() + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify(body),
    });
    await res.arrayBuffer();
    return { status: res.status, ms: performance.now() - started };
  } catch {
    return { status: 0, ms: performance.now() - started };
  }
}

/** Gauges (ex.: backlog do outbox) são do banco: cada instância vê o mesmo valor → máximo, não soma. */
async function scrapeMax(name: string): Promise<number> {
  let max = 0;
  for (const b of new Set(bases)) {
    try {
      const text = await (await fetch(`${b}/metrics`)).text();
      for (const line of text.split("\n")) {
        if (line.startsWith(name) && !line.startsWith("#")) max = Math.max(max, Number(line.split(" ").pop()));
      }
    } catch {}
  }
  return max;
}

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0;

async function scrape(name: string): Promise<number> {
  let total = 0;
  for (const b of new Set(bases)) {
    try {
      const text = await (await fetch(`${b}/metrics`)).text();
      for (const line of text.split("\n")) {
        if (line.startsWith(name) && !line.startsWith("#")) total += Number(line.split(" ").pop());
      }
    } catch {}
  }
  return total;
}

async function main() {
  console.log(`Preparando ${WALLETS} carteiras…`);
  const wallets: { walletId: string; playerId: string }[] = [];
  for (let i = 0; i < WALLETS; i++) {
    const playerId = `load-${randomUUID()}`;
    const res = await fetch(base() + "/wallets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId, initialBalance: { amount: "1000000.00", currency: "BRL" } }),
    });
    if (res.status !== 201) throw new Error(`falha ao criar carteira: ${res.status}`);
    wallets.push({ walletId: ((await res.json()) as { id: string }).id, playerId });
  }

  const lockBefore = await scrape("db_lock_conflicts_total");
  const dupBefore = await scrape("wager_duplicates_total");
  const latencies: number[] = [];
  const statuses = new Map<number, number>();
  let next = 0;
  const t0 = performance.now();

  async function worker() {
    while (next < REQUESTS) {
      const n = next++;
      const w = Math.random() < HOT ? wallets[0]! : wallets[n % wallets.length]!;
      const ext = `load-${n}-${randomUUID()}`;
      const key = randomUUID();
      const body = {
        providerId: "prov-load", externalTransactionId: ext, playerId: w.playerId, walletId: w.walletId,
        roundId: "r", gameId: "g", kind: "BET", money: { amount: "1.00", currency: "BRL" },
      };
      const r = await call("/wagering/transactions", body, key);
      latencies.push(r.ms);
      statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
      if (Math.random() < DUP) {
        const d = await call("/wagering/transactions", body, key); // retry idempotente
        latencies.push(d.ms);
        statuses.set(d.status, (statuses.get(d.status) ?? 0) + 1);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = (performance.now() - t0) / 1000;

  latencies.sort((a, b) => a - b);
  const total = latencies.length;
  const errors = [...statuses].filter(([s]) => s === 0 || s >= 500).reduce((a, [, c]) => a + c, 0);

  console.log("\n=== Resultado ===");
  console.log(`requisições: ${total} em ${elapsed.toFixed(2)}s  (${(total / elapsed).toFixed(1)} req/s)`);
  console.log(`latência ms: p50=${pct(latencies, 50).toFixed(1)} p95=${pct(latencies, 95).toFixed(1)} p99=${pct(latencies, 99).toFixed(1)} max=${(latencies.at(-1) ?? 0).toFixed(1)}`);
  console.log(`status: ${[...statuses].map(([s, c]) => `${s}×${c}`).join("  ")}`);
  console.log(`taxa de erro (5xx/rede): ${((errors / total) * 100).toFixed(2)}%`);
  console.log(`conflitos de lock/serialização (delta): ${(await scrape("db_lock_conflicts_total")) - lockBefore}`);
  console.log(`duplicatas detectadas (replays idempotentes): ${(await scrape("wager_duplicates_total")) - dupBefore}`);

  // Outbox lag: idade do evento pendente mais antigo ao fim da carga (o maior entre
  // as instâncias) e quanto tempo os publishers levam para drenar o backlog.
  const lagAtEnd = await scrapeMax("outbox_lag_seconds");
  const pendingAtEnd = await scrapeMax("outbox_pending_events");
  const drainStarted = performance.now();
  let pending = pendingAtEnd;
  while (pending > 0 && performance.now() - drainStarted < 120_000) {
    await new Promise((r) => setTimeout(r, 250));
    pending = await scrapeMax("outbox_pending_events");
  }
  const drainSeconds = (performance.now() - drainStarted) / 1000;
  console.log(
    `outbox: ${pendingAtEnd} pendentes ao fim da carga, lag=${lagAtEnd.toFixed(2)}s; ` +
      (pending === 0 ? `drenado em ${drainSeconds.toFixed(2)}s` : `ainda ${pending} pendentes após 120s`),
  );

  let bad = 0;
  for (const w of wallets) {
    const r = await fetch(`${base()}/wallets/${w.walletId}/reconciliation`, { method: "POST" });
    const body = (await r.json()) as { consistent: boolean };
    if (!body.consistent) bad++;
  }
  console.log(`reconciliação: ${wallets.length - bad}/${wallets.length} carteiras consistentes`);
  if (bad > 0 || errors > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
