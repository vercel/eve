import { inMemory, MemoryDocumentConflictError, type MemoryDocumentBackend } from "eve/memory/file";
import { vercelBlob } from "eve/memory/file/vercel";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * The fixture weather provider's grants, one per person, and which of a person's calls finished
 * their protected work.
 * A deployment runs calls on many instances, so there they live in Vercel Blob; `eve dev` runs one
 * process.
 */
const PREFIX = "eve/e2e/agent-subagents-hitl/weather-grants";
const BACKEND = process.env.VERCEL ? "blob" : "memory";
const store: MemoryDocumentBackend = process.env.VERCEL
  ? vercelBlob({ prefix: PREFIX })
  : inMemory();

/** FIXTURE-TRACE: one storage operation as this instance saw it. */
export interface TraceEntry {
  readonly op: "read" | "write";
  readonly key: string;
  readonly path: string;
  readonly at: string;
  readonly ms: number;
  readonly result: string;
}

const INSTANCE = randomUUID().slice(0, 8);
const traceLog: TraceEntry[] = [];

/** FIXTURE-TRACE: where this instance's storage goes. */
export function traceContext() {
  return {
    backend: BACKEND,
    instance: INSTANCE,
    region: process.env.VERCEL_REGION ?? null,
    store: process.env.BLOB_STORE_ID ?? null,
    vercel: process.env.VERCEL ?? null,
  };
}

/** FIXTURE-TRACE: this instance's operations on keys under `person` since `since`. */
export function traceFor(person: string, since = 0) {
  return {
    ...traceContext(),
    ops: traceLog.filter((entry) => entry.key.startsWith(person) && entry.ms >= since),
  };
}

function record(op: TraceEntry["op"], key: string, ms: number, result: string) {
  const path = `${PREFIX}/${encodeURIComponent(key)}/MEMORY.md`;
  // Polls repeat one result; keep the first and the latest of each run per key.
  const same = traceLog.flatMap((entry, index) =>
    entry.key === key && entry.op === op ? [index] : [],
  );
  const [before, latest] = same.slice(-2);
  if (
    op === "read" &&
    before !== undefined &&
    latest !== undefined &&
    traceLog[before]!.result === result &&
    traceLog[latest]!.result === result
  )
    traceLog.splice(latest, 1);
  traceLog.push({ at: new Date(ms).toISOString(), key, ms, op, path, result });
  if (traceLog.length > 400) traceLog.splice(0, traceLog.length - 400);
}

const grants: MemoryDocumentBackend = {
  async read(input) {
    const ms = Date.now();
    try {
      const document = await store.read(input);
      record("read", input.key, ms, document === null ? "null" : `found ${document.version}`);
      return document;
    } catch (error) {
      record("read", input.key, ms, `threw ${String(error).slice(0, 120)}`);
      throw error;
    }
  },
  async write(input) {
    const ms = Date.now();
    try {
      const document = await store.write(input);
      record("write", input.key, ms, `ok ${document.version} expected=${input.expectedVersion}`);
      return document;
    } catch (error) {
      record("write", input.key, ms, `threw ${String(error).slice(0, 120)}`);
      throw error;
    }
  },
};

/** Each provider request gets ten seconds. */
function deadline(): AbortSignal {
  return AbortSignal.timeout(10_000);
}

interface GrantRecord {
  /** The token the grant yields, or `null` once the provider revoked it. */
  readonly token: string | null;
}

async function readRecord(person: string) {
  const document = await grants.read({ key: person, signal: deadline() });
  if (document === null) return { record: undefined, version: null };
  return { record: JSON.parse(document.content) as GrantRecord, version: document.version };
}

/** The token `person`'s grant yields, or `undefined` when they hold none. */
export async function readGrant(person: string): Promise<string | undefined> {
  return (await readRecord(person)).record?.token ?? undefined;
}

/** Records the grant `person`'s accepted sign-in created. */
export async function storeGrant(person: string, token: string) {
  const { version } = await readRecord(person);
  const record: GrantRecord = { token };
  await grants.write({
    content: JSON.stringify(record),
    expectedVersion: version,
    key: person,
    signal: deadline(),
  });
}

/** Revokes `person`'s grant at the provider, as a person removing the app's access would. */
export async function revokeGrant(person: string) {
  const { record, version } = await readRecord(person);
  if (record?.token == null) throw new Error(`No weather grant to revoke for ${person}.`);
  const revoked: GrantRecord = { token: null };
  await grants.write({
    content: JSON.stringify(revoked),
    expectedVersion: version,
    key: person,
    signal: deadline(),
  });
}

/**
 * Records that `person`'s call for `city` finished its protected work, for a held call to wait on.
 * It is written just before `get_weather` returns.
 */
export async function markReturned(person: string, city: string) {
  await grants.write({
    content: "returned",
    expectedVersion: null,
    key: `${person}/returned/${city}`,
    signal: deadline(),
  });
}

/**
 * Waits until `person`'s calls for every city in `cities` have finished their protected work, or
 * fails after `limitMs`: a call that holds this way returns only after the calls it waits on.
 */
export async function awaitReturned(person: string, cities: readonly string[], limitMs: number) {
  const until = Date.now() + limitMs;
  for (;;) {
    const returned = await Promise.all(
      cities.map((city) => grants.read({ key: `${person}/returned/${city}`, signal: deadline() })),
    );
    const waiting = cities.filter((_, index) => returned[index] === null);
    if (waiting.length === 0) return;
    if (Date.now() > until)
      throw new Error(
        `The other weather calls didn't return within ${limitMs} ms: ${waiting.join(", ")}. FIXTURE-TRACE ${JSON.stringify(traceFor(person))}`,
      );
    await sleep(200);
  }
}

/** Records that `person`'s parent asked for its own sign-in; a second record is the same fact. */
export async function markParentAsked(person: string) {
  try {
    await grants.write({
      content: "asked",
      expectedVersion: null,
      key: `${person}/parent-asked`,
      signal: deadline(),
    });
  } catch (error) {
    if (!MemoryDocumentConflictError.is(error)) throw error;
  }
}

/** Waits until `person`'s parent asked for its own sign-in, or fails after `limitMs`. */
export async function awaitParentAsked(person: string, limitMs: number) {
  const until = Date.now() + limitMs;
  while ((await grants.read({ key: `${person}/parent-asked`, signal: deadline() })) === null) {
    if (Date.now() > until) throw new Error(`The parent didn't ask within ${limitMs} ms.`);
    await sleep(200);
  }
}
