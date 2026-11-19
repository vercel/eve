import { Redis } from "@upstash/redis";

/*
 * Fixed-window limits, from the voice template. With Upstash Redis connected they hold across
 * every server instance; without it, each instance counts on its own, which still slows down
 * a single caller hammering one instance.
 */

type LimitOptions = {
  readonly key: string;
  readonly limit: number;
  readonly prefix: string;
  readonly windowSeconds: number;
};

export class RateLimitError extends Error {
  readonly retryAfter: number;

  constructor(retryAfter: number) {
    super("Too many requests. Please wait a moment and try again.");
    this.retryAfter = retryAfter;
  }
}

let redis: Redis | null | undefined;

function getRedisEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim() || process.env.KV_REST_API_URL?.trim();
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || process.env.KV_REST_API_TOKEN?.trim();

  return url && token ? { token, url } : null;
}

function getRedis() {
  if (redis !== undefined) {
    return redis;
  }

  const env = getRedisEnv();

  if (!env) {
    redis = null;
    return redis;
  }

  redis = new Redis(env);
  return redis;
}

/** Counts for instances without Redis, by window key; old windows are dropped as they pass. */
const local = new Map<string, number>();
const MAX_LOCAL_KEYS = 10_000;

function countLocally(key: string): number {
  if (local.size >= MAX_LOCAL_KEYS) local.clear();
  const count = (local.get(key) ?? 0) + 1;
  local.set(key, count);
  return count;
}

type WindowOptions = Omit<LimitOptions, "limit">;

function windowKey(options: WindowOptions, now: number) {
  const windowId = Math.floor(now / options.windowSeconds);
  return { windowId, key: `rate:${options.prefix}:${options.key}:${windowId}` };
}

/** Adds one to a window's counter and returns the new count. */
export async function countInWindow(options: WindowOptions): Promise<number> {
  const client = getRedis();
  const { windowId, key } = windowKey(options, Math.floor(Date.now() / 1000));
  if (client) {
    const count = await client.incr(key);
    if (count === 1) await client.expire(key, options.windowSeconds);
    return count;
  }
  for (const existing of local.keys()) {
    if (existing.startsWith(`rate:${options.prefix}:`) && !existing.endsWith(`:${windowId}`))
      local.delete(existing);
  }
  return countLocally(key);
}

/** A window's counter, without adding to it. */
export async function readWindow(options: WindowOptions): Promise<number> {
  const client = getRedis();
  const { key } = windowKey(options, Math.floor(Date.now() / 1000));
  if (client) return Number((await client.get<number>(key)) ?? 0);
  return local.get(key) ?? 0;
}

export async function enforceRateLimit(options: LimitOptions) {
  const count = await countInWindow(options);
  if (count > options.limit) {
    const now = Math.floor(Date.now() / 1000);
    throw new RateLimitError(options.windowSeconds - (now % options.windowSeconds));
  }
}
