import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

if (process.env.POSTGRES_DB !== "financial_wallet_test") {
  throw new Error("Multi-instance tests must run against financial_wallet_test.");
}

/**
 * Sobe 3 processos independentes da API (portas distintas, mesmo Postgres) e
 * dispara carga concorrente distribuída entre eles. A prova de que não há
 * estado em memória compartilhado: o resultado final depende só do banco.
 */
const PORTS = [3101, 3102, 3103];
const ENTRY = process.env.APP_ENTRY ?? "src/main.ts";
const children: ChildProcess[] = [];
const url = (i: number, path: string) => `http://127.0.0.1:${PORTS[i % PORTS.length]}${path}`;

async function waitReady(port: number): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health/live`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`instance on ${port} did not become ready`);
}

function startInstance(index: number): void {
  children[index] = spawn("bun", [ENTRY], {
    env: { ...process.env, PORT: String(PORTS[index]) },
    stdio: "ignore",
  });
}

function startInstances(): void {
  PORTS.forEach((_, index) => startInstance(index));
}

async function waitStopped(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/health/live`);
    } catch {
      return; // conexão recusada: o processo morreu
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`instance on ${port} is still answering after SIGKILL`);
}

async function post(i: number, path: string, body: unknown, key?: string) {
  const res = await fetch(url(i, path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function get(i: number, path: string) {
  const res = await fetch(url(i, path));
  return (await res.json()) as any;
}

describe("multi-instância (3 processos, 1 Postgres)", () => {
  beforeAll(async () => {
    startInstances();
    await Promise.all(PORTS.map(waitReady));
  }, 90_000);

  afterAll(async () => {
    for (const c of children) c.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  });

  const mkWallet = async (amount: string) => {
    const playerId = `p-${randomUUID()}`;
    const res = await post(0, "/wallets", {
      playerId,
      initialBalance: { amount, currency: "BRL" },
    });
    expect(res.status).toBe(201);
    return { walletId: res.body.id as string, playerId };
  };

  const bet = (w: { walletId: string; playerId: string }, amount: string, ext: string) => ({
    providerId: "prov-multi",
    externalTransactionId: ext,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: "r",
    gameId: "g",
    kind: "BET",
    money: { amount, currency: "BRL" },
  });

  it("mesma Idempotency-Key em 3 instâncias: 1 efeito financeiro", async () => {
    const w = await mkWallet("100.00");
    const key = randomUUID();
    const body = bet(w, "10.00", `same-${randomUUID()}`);
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => post(i, "/wagering/transactions", body, key)),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const wallet = await get(1, `/wallets/${w.walletId}`);
    expect(wallet.balance.amount).toBe("90.00");
  }, 60_000);

  it("saldo 100, 20 BETs de 10 em instâncias distintas: exatamente 10 passam, saldo 0,00, nunca negativo", async () => {
    const w = await mkWallet("100.00");
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post(i, "/wagering/transactions", bet(w, "10.00", `b-${i}-${randomUUID()}`), randomUUID()),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(10);
    expect(results.filter((r) => r.status === 422)).toHaveLength(10);
    const wallet = await get(2, `/wallets/${w.walletId}`);
    expect(wallet.balance.amount).toBe("0.00");
    const rec = await post(0, `/wallets/${w.walletId}/reconciliation`, {});
    expect(rec.body.consistent).toBe(true);
  }, 60_000);

  it("carteiras diferentes em paralelo não se bloqueiam e todas reconciliam", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => mkWallet("50.00")));
    await Promise.all(
      wallets.flatMap((w, wi) =>
        Array.from({ length: 5 }, (_, i) =>
          post(wi + i, "/wagering/transactions", bet(w, "5.00", `m-${wi}-${i}-${randomUUID()}`), randomUUID()),
        ),
      ),
    );
    for (const w of wallets) {
      const wallet = await get(0, `/wallets/${w.walletId}`);
      expect(wallet.balance.amount).toBe("25.00");
      const rec = await post(1, `/wallets/${w.walletId}/reconciliation`, {});
      expect(rec.body.consistent).toBe(true);
    }
  }, 90_000);

  it("consistência após matar (SIGKILL) e reiniciar uma instância durante a carga", async () => {
    const w = await mkWallet("100.00");
    const ext = (i: number) => `k-${w.walletId}-${i}`;
    const key = (i: number) => `key-${w.walletId}-${i}`;
    const TOTAL = 20; // 20 × 5,00 = 100,00: ao final o saldo é exatamente 0,00

    // Carga distribuída nas TRÊS instâncias, inclusive a que vai morrer.
    const inflight = Array.from({ length: TOTAL }, (_, i) =>
      post(i, "/wagering/transactions", bet(w, "5.00", ext(i)), key(i)).catch(() => null),
    );
    // Mata a instância 0 com requisições dela em andamento (algumas antes, outras
    // depois do COMMIT): o cliente não sabe quais foram aplicadas.
    await new Promise((r) => setTimeout(r, 15));
    children[0]!.kill("SIGKILL");
    const firstRound = await Promise.all(inflight);
    await waitStopped(PORTS[0]!);
    const lost = firstRound.filter((r) => r === null || r.status !== 200).length;

    // Reinício do serviço: nova instância na MESMA porta, mesmo banco.
    startInstance(0);
    await waitReady(PORTS[0]!);

    // Retry do cliente com as MESMAS chaves, em todas as instâncias (inclusive a reiniciada).
    const retries = await Promise.all(
      Array.from({ length: TOTAL }, (_, i) =>
        post(i + 1, "/wagering/transactions", bet(w, "5.00", ext(i)), key(i)),
      ),
    );
    expect(retries.every((r) => r.status === 200)).toBe(true);
    expect(retries.every((r) => r.body.status === "PROCESSED")).toBe(true);
    // Quem já tinha sido aplicado antes do kill volta como replay — nunca como novo débito.
    expect(retries.filter((r) => !r.body.idempotentReplay).length).toBeLessThanOrEqual(lost);

    // Consistência final, consultada na instância reiniciada.
    const wallet = await get(0, `/wallets/${w.walletId}`);
    expect(wallet.balance.amount).toBe("0.00"); // 20 × 5,00 debitados exatamente uma vez
    const rec = await post(0, `/wallets/${w.walletId}/reconciliation`, {});
    expect(rec.body.consistent).toBe(true);
    expect(rec.body.checkedEntries).toBe(TOTAL + 1); // OPENING + 20 débitos
  }, 90_000);
});
