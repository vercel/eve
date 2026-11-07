import { inMemory, type MemoryDocumentBackend } from "eve/memory/file";
import { vercelBlob } from "eve/memory/file/vercel";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * The fixture weather provider's grants, one per person, and which of a person's calls finished
 * their protected work.
 * A deployment runs calls on many instances, so there they live in Vercel Blob; `eve dev` runs one
 * process.
 */
const grants: MemoryDocumentBackend = process.env.VERCEL
  ? vercelBlob({ prefix: "eve/e2e/agent-subagents-hitl/weather-grants" })
  : inMemory();

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
        `The other weather calls didn't return within ${limitMs} ms: ${waiting.join(", ")}.`,
      );
    await sleep(200);
  }
}
