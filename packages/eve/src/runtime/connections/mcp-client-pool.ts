import { AsyncLocalStorage } from "node:async_hooks";

import { McpConnectionClient } from "#runtime/connections/mcp-client.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

export class McpClientPool {
  readonly #entries = new Map<string, PoolEntry>();
  readonly #leased = new Map<McpConnectionClient, PoolEntry>();
  readonly #idleMs: number;
  readonly #maxIdleClients: number;
  readonly #ids = new WeakMap<ResolvedConnectionDefinition, number>();
  #nextId = 0;

  constructor(options: { readonly idleMs?: number; readonly maxIdleClients?: number } = {}) {
    this.#idleMs = options.idleMs ?? 60_000;
    this.#maxIdleClients = options.maxIdleClients ?? 128;
  }

  get size(): number {
    return this.#entries.size;
  }

  acquire(scope: string, connection: ResolvedConnectionDefinition): McpConnectionClient {
    const key = `${this.#connectionId(connection)}:${scope}`;
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      entry = { client: new McpConnectionClient(connection), key, leases: 0, retired: false };
      this.#entries.set(key, entry);
    }
    this.#leased.set(entry.client, entry);
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.leases += 1;
    return entry.client;
  }

  async release(client: McpConnectionClient, options: { readonly discard?: boolean } = {}) {
    const entry = this.#leased.get(client);
    if (entry === undefined) return;
    entry.leases -= 1;
    if (options.discard === true || !client.reusable) {
      entry.retired = true;
      if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
    }
    if (entry.leases > 0) return;
    this.#leased.delete(client);
    if (entry.retired) {
      await closeQuietly(client);
      return;
    }

    this.#entries.delete(entry.key);
    this.#entries.set(entry.key, entry);
    entry.releaseContext = AsyncLocalStorage.snapshot();
    entry.idleTimer = setTimeout(() => void this.#evict(entry), this.#idleMs);
    entry.idleTimer.unref?.();
    const idle = [...this.#entries.values()].filter((candidate) => candidate.leases === 0);
    for (const excess of idle.slice(0, Math.max(0, idle.length - this.#maxIdleClients))) {
      void this.#evict(excess);
    }
  }

  async closeIdle(): Promise<void> {
    const idle = [...this.#entries.values()].filter((entry) => entry.leases === 0);
    await Promise.all(idle.map((entry) => this.#evict(entry)));
  }

  async #evict(entry: PoolEntry): Promise<void> {
    if (this.#entries.get(entry.key) !== entry || entry.leases > 0) return;
    clearTimeout(entry.idleTimer);
    this.#entries.delete(entry.key);
    const runInReleaseContext = entry.releaseContext ?? ((fn) => fn());
    await runInReleaseContext(() => closeQuietly(entry.client));
  }

  #connectionId(connection: ResolvedConnectionDefinition): number {
    let id = this.#ids.get(connection);
    if (id === undefined) {
      id = this.#nextId++;
      this.#ids.set(connection, id);
    }
    return id;
  }
}

interface PoolEntry {
  readonly client: McpConnectionClient;
  readonly key: string;
  leases: number;
  retired: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  releaseContext?: <R>(fn: () => R) => R;
}

async function closeQuietly(client: McpConnectionClient): Promise<void> {
  await client.close().catch(() => undefined);
}

export const mcpClientPool = new McpClientPool();
