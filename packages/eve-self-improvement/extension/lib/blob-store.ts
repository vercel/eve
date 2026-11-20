import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BlobNotFoundError, BlobPreconditionFailedError, del, get, list, put } from "@vercel/blob";
import { digest } from "./config.js";
import type { Storage } from "./storage.js";
import type { Active, Experiment, Lease, Observation } from "./types.js";

export interface BlobObject {
  text: string;
  etag: string;
}
export interface BlobObjects {
  read(path: string): Promise<BlobObject | null>;

  write(path: string, text: string, etag: string | null, ttlDays?: number): Promise<boolean>;
  remove(path: string, etag: string): Promise<boolean>;
  list(
    prefix: string,
    cursor?: string,
  ): Promise<{ objects: { path: string; etag: string }[]; cursor?: string }>;
}

/** @internal */
export function blobObjects(
  sdk: { get: typeof get; put: typeof put; del: typeof del; list: typeof list } = {
    get,
    put,
    del,
    list,
  },
): BlobObjects {
  const objects: BlobObjects = {
    async read(path) {
      const result = await sdk.get(path, {
        access: "private",
        useCache: false,
        headers: { "accept-encoding": "identity" },
        abortSignal: AbortSignal.timeout(30000),
      });
      if (!result) return null;
      if (result.statusCode !== 200) throw new Error("Expected fresh Blob content");

      if (!result.blob.etag || /^W\//i.test(result.blob.etag))
        throw new Error("Blob did not return a strong origin ETag");
      return { text: await new Response(result.stream).text(), etag: result.blob.etag };
    },
    async write(path, text, etag, ttlDays) {
      try {
        const options: Parameters<typeof sdk.put>[2] = {
          access: "private",
          addRandomSuffix: false,
          contentType: "application/json",
          allowOverwrite: etag !== null,
          abortSignal: AbortSignal.timeout(30000),
        };
        if (etag !== null) options.ifMatch = etag;
        if (ttlDays) options.ttlDays = ttlDays;
        await sdk.put(path, text, options);
        return true;
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) return false;

        if (etag === null) {
          const existing = await objects.read(path);
          if (existing) return existing.text === text;
        }
        throw error;
      }
    },
    async remove(path, etag) {
      try {
        await sdk.del(path, { ifMatch: etag, abortSignal: AbortSignal.timeout(30000) });
        return true;
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError || error instanceof BlobNotFoundError)
          return false;
        throw error;
      }
    },
    async list(prefix, cursor) {
      const page = await sdk.list({
        prefix,
        cursor,
        limit: 1000,
        abortSignal: AbortSignal.timeout(30000),
      });
      if (page.hasMore && !page.cursor)
        throw new Error("Blob listing omitted its continuation cursor");
      return {
        objects: page.blobs.map((blob) => ({ path: blob.pathname, etag: blob.etag })),
        cursor: page.hasMore ? page.cursor : undefined,
      };
    },
  };
  return objects;
}

const DAY = 86400000;
interface Entry {
  value: unknown;
  expiresAt: number;
}
interface Control {
  version: 1;
  revision: string;
  fence: number;
  owner: string | null;
  until: number;
  experiment: Experiment | null;
  records: Record<string, Entry>;
}
interface Sample {
  value: Observation;
  expiresAt: number;
  index: string;
}
const initial = (): Control => ({
  version: 1,
  revision: "",
  fence: 0,
  owner: null,
  until: 0,
  experiment: null,
  records: {},
});

export class BlobStore implements Storage {
  readonly prefix: string;
  constructor(
    readonly objects: BlobObjects,
    readonly scope: string,
    readonly retentionDays = 7,
    readonly ledgerDays = 90,
    readonly now = Date.now,
  ) {
    this.prefix = `eve-self-improvement/${encodeURIComponent(scope)}/`;
  }
  private async control() {
    const object = await this.objects.read(`${this.prefix}control.json`);
    if (!object) return { state: initial(), etag: null };
    const state = JSON.parse(object.text) as Control;
    if (
      state.version !== 1 ||
      !Number.isSafeInteger(state.fence) ||
      !state.records ||
      typeof state.revision !== "string"
    )
      throw new Error("Unsupported or corrupt self-improvement Blob state");
    return { state, etag: object.etag };
  }
  private async change<T>(update: (state: Control) => { value: T; write: boolean }): Promise<T> {
    for (let attempt = 0; attempt < 24; attempt++) {
      const { state, etag } = await this.control();
      const result = update(state);
      if (!result.write) return result.value;
      state.revision = randomUUID();
      try {
        if (await this.objects.write(`${this.prefix}control.json`, JSON.stringify(state), etag))
          return result.value;

        if ((await this.control()).state.revision === state.revision) return result.value;
      } catch (error) {
        if ((await this.control()).state.revision === state.revision) return result.value;
        throw error;
      }
      await delay(Math.min(50, attempt * 3) + Math.random() * 10);
    }
    throw new Error("Self-improvement Blob contention; retry after reconciling stored state");
  }
  private checkLease(state: Control, lease: Lease) {
    if (state.owner !== lease.owner || state.fence !== lease.fence || state.until <= this.now())
      throw new Error(
        "Self-improvement lease expired or was superseded; reconcile before retrying",
      );
  }
  async hasRecord(key: string): Promise<boolean> {
    const { state } = await this.control();
    return key === "active" ? state.fence > 0 : Object.hasOwn(state.records, key);
  }
  async get<T>(key: string): Promise<T | null> {
    const { state } = await this.control();
    if (key === "active") return state.experiment as T | null;
    const entry = Object.hasOwn(state.records, key) ? state.records[key] : undefined;
    return entry && entry.expiresAt > this.now() ? (entry.value as T) : null;
  }
  async put(key: string, value: unknown, days = this.ledgerDays): Promise<void> {
    if (key === "active") throw new Error("Use fenced save for the active experiment");
    await this.change((state) => {
      Object.defineProperty(state.records, key, {
        value: { value, expiresAt: this.now() + days * DAY },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return { value: undefined, write: true };
    });
  }
  async list<T>(prefix: string, limit = 100): Promise<T[]> {
    const { state } = await this.control();
    const entries = Object.entries(state.records).filter(
      ([key, entry]) => key.startsWith(prefix) && entry.expiresAt > this.now(),
    );
    if (state.fence && "active".startsWith(prefix))
      entries.push(["active", { value: state.experiment, expiresAt: Infinity }]);
    const time = (entry: Entry) => {
      const value = entry.value as { updatedAt?: number; createdAt?: number } | null;
      return value?.updatedAt ?? value?.createdAt ?? 0;
    };
    return entries
      .sort(([a, x], [b, y]) => time(y) - time(x) || a.localeCompare(b))
      .slice(0, limit)
      .map(([, entry]) => entry.value as T);
  }
  async acquire(owner: string, leaseMs = 3600000): Promise<Active | null> {
    return this.change((state) => {
      if (state.owner && state.until > this.now()) return { value: null, write: false };
      if (!Number.isSafeInteger(state.fence + 1))
        throw new Error("Self-improvement fencing counter exhausted");
      state.fence++;
      state.owner = owner;
      state.until = this.now() + leaseMs;
      return {
        value: {
          lease: { owner, fence: state.fence, until: state.until },
          experiment: state.experiment,
        },
        write: true,
      };
    });
  }
  async save(lease: Lease, experiment: Experiment | null): Promise<void> {
    await this.change((state) => {
      this.checkLease(state, lease);
      state.experiment = experiment;
      state.records[experiment ? `experiment:${experiment.id}` : "last-idle"] = {
        value: experiment,
        expiresAt: this.now() + this.ledgerDays * DAY,
      };
      return { value: undefined, write: true };
    });
  }
  async renew(lease: Lease, leaseMs = 3600000): Promise<void> {
    await this.change((state) => {
      this.checkLease(state, lease);
      state.until = this.now() + leaseMs;
      return { value: undefined, write: true };
    });
  }
  async bindSession(
    lease: Lease,
    field: "coordinatorSession" | "writerSession",
    session: string,
  ): Promise<Experiment> {
    return this.change((state) => {
      this.checkLease(state, lease);
      const e = state.experiment;
      if (!e || (e[field] && e[field] !== session))
        throw new Error(
          "Another delegated session already owns this evolution stage, or the lease expired",
        );
      if (e[field] === session) return { value: e, write: false };
      e[field] = session;
      return { value: e, write: true };
    });
  }
  async release(lease: Lease): Promise<void> {
    await this.change((state) => {
      if (state.owner !== lease.owner || state.fence !== lease.fence)
        return { value: undefined, write: false };
      state.owner = null;
      state.until = 0;
      return { value: undefined, write: true };
    });
  }
  async active(): Promise<Active | null> {
    const { state } = await this.control();
    return state.experiment
      ? {
          experiment: state.experiment,
          lease: { owner: state.owner!, fence: state.fence, until: state.until },
        }
      : null;
  }
  private samplePath(id: string) {
    return `${this.prefix}observations/${digest(id)}.json`;
  }
  private indexPath(value: Observation, expiresAt: number) {
    return `${this.prefix}index/${new Date(value.at).toISOString().slice(0, 10)}/${value.at}_${expiresAt}_${digest(value.id)}.json`;
  }
  private ttl(expiresAt: number) {
    return Math.max(1, Math.ceil((expiresAt - this.now()) / DAY) + 1);
  }
  private async index(sample: Sample) {
    if (sample.expiresAt > this.now())
      await this.objects.write(sample.index, "{}", null, this.ttl(sample.expiresAt) + 1);
  }
  async observe(value: Observation): Promise<void> {
    const path = this.samplePath(value.id),
      previous = await this.objects.read(path);
    if (previous) {
      await this.index(JSON.parse(previous.text));
      return;
    }
    const sample: Sample = { value, expiresAt: value.at + this.retentionDays * DAY, index: "" };
    if (sample.expiresAt <= this.now()) return;
    sample.index = this.indexPath(value, sample.expiresAt);

    if (await this.objects.write(path, JSON.stringify(sample), null, this.ttl(sample.expiresAt))) {
      await this.index(sample);
      return;
    }
    const saved = await this.objects.read(path);
    if (!saved) throw new Error("Observation write was not confirmed");
    await this.index(JSON.parse(saved.text) as Sample);
  }

  private async *pages(prefix: string) {
    let cursor: string | undefined;
    do {
      const page = await this.objects.list(prefix, cursor);
      yield page.objects;
      if (page.cursor && page.cursor === cursor) throw new Error("Blob listing did not advance");
      cursor = page.cursor;
    } while (cursor);
  }
  async observations(
    from: number,
    to: number,
  ): Promise<{ values: Observation[]; complete: boolean }> {
    if (to <= from) return { values: [], complete: true };
    const first = Math.floor(from / DAY),
      last = Math.floor((to - 1) / DAY);

    const prefixes =
      last - first <= 32
        ? Array.from(
            { length: last - first + 1 },
            (_, i) =>
              `${this.prefix}index/${new Date((first + i) * DAY).toISOString().slice(0, 10)}/`,
          )
        : [`${this.prefix}index/`];
    const values: Observation[] = [],
      seen = new Set<string>();
    let complete = true;
    for (const prefix of prefixes)
      for await (const page of this.pages(prefix)) {
        const markers = page.filter((object) => {
          const [at, expiry] = object.path.split("/").at(-1)!.split("_").map(Number);
          return at >= from && at < to && expiry > this.now();
        });
        for (let i = 0; i < markers.length; i += 16) {
          const samples = await Promise.all(
            markers.slice(i, i + 16).map(async (marker) => {
              const hash = marker.path.split("_").at(-1)!;
              const object = await this.objects.read(`${this.prefix}observations/${hash}`);
              if (!object) {
                complete = false;
                return null;
              }
              const sample = JSON.parse(object.text) as Sample;
              if (sample.index !== marker.path) {
                complete = false;
                return null;
              }
              return sample;
            }),
          );
          for (const sample of samples)
            if (
              sample &&
              sample.expiresAt > this.now() &&
              sample.value.at >= from &&
              sample.value.at < to &&
              !seen.has(sample.value.id)
            ) {
              seen.add(sample.value.id);
              values.push(sample.value);
            }
          if (values.length > 10000)
            return { values: values.sort((a, b) => a.at - b.at).slice(0, 10000), complete: false };
        }
      }
    return { values: values.sort((a, b) => a.at - b.at), complete };
  }
  async purge(): Promise<number> {
    const now = this.now();
    let removed = await this.change((state) => {
      let count = 0;
      for (const [key, entry] of Object.entries(state.records))
        if (entry.expiresAt <= now) {
          delete state.records[key];
          count++;
        }
      return { value: count, write: count > 0 };
    });

    for await (const page of this.pages(`${this.prefix}observations/`))
      for (let i = 0; i < page.length; i += 16) {
        await Promise.all(
          page.slice(i, i + 16).map(async (item) => {
            const object = await this.objects.read(item.path);
            if (
              object &&
              (JSON.parse(object.text) as Sample).expiresAt <= now &&
              (await this.objects.remove(item.path, object.etag))
            )
              removed++;
          }),
        );
      }
    for await (const page of this.pages(`${this.prefix}index/`))
      for (let i = 0; i < page.length; i += 16) {
        await Promise.all(
          page.slice(i, i + 16).map(async (item) => {
            const [at, expiry, hash] = item.path.split("/").at(-1)!.split("_");
            if (!Number.isFinite(Number(at)) || !Number.isFinite(Number(expiry)) || !hash) return;
            if (Number(expiry) <= now) {
              await this.objects.remove(item.path, item.etag);
              return;
            }
            const body = await this.objects.read(`${this.prefix}observations/${hash}`);
            if (!body || (JSON.parse(body.text) as Sample).index !== item.path)
              await this.objects.remove(item.path, item.etag);
          }),
        );
      }
    return removed;
  }
}
