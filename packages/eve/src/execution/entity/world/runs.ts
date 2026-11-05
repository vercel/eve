import type { JournalRecord, LoadedJournal } from "#execution/entity/entities.js";
import { TakenOverError } from "#execution/entity/entities.js";
import type { RuntimeWorld, WorldEvent } from "#execution/world/runtime-world.js";
import { isEntityConflict, isInBandSuperseded, isRunNotFound } from "#shared/run-errors.js";
import { createUlid } from "#shared/ulid.js";

// An entity on today's Worlds: one run, that no workflow executes.
//   - Its key is `<kind>_` and a ULID; its run is `wrun_` and the same ULID, as Workflow names
//     runs, so any World accepts it. What it was created with is the run's input.
//   - Its journal is `step_created` events on the run's log, the record's kind as the step's name
//     and an envelope as its input: the value, whether it's a snapshot, and how far the mailbox
//     is consumed (`Envelope`). Internal records (`entity.*`) carry the layer's own bookkeeping.
//   - One writer at a time: on a World with the in-band fence (`capabilities.inBandFence`), the
//     run is created at spec 9 and every write is fenced (`Writer`); a writer that opens an
//     existing entity claims it first, and the World refuses the writes of any earlier writer,
//     writing nothing for them. On a World without the fence, writes go as they are.

const LIST_PAGE = 100;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The spec version of a fenced run, whose deliveries the World also serializes. */
export const FENCED_SPEC = 9;

/** The layer's own records: a claim, a stream write's announcement, a consumption. */
export const CLAIM_RECORD = "entity.claim";
export const STREAM_RECORD = "entity.stream";
export const CONSUMED_RECORD = "entity.consumed";

/** How one kind of entity sits on a World. */
export interface EntityKind {
  /** The keys' prefix: `session` keys are `session_<ULID>`. */
  readonly kind: string;
  /** The workflow name its runs carry, so a list of runs finds them. */
  readonly workflowName: string;
  /** The namespace its stream's name carries (base64url-encoded). */
  readonly streamNamespace: string;
  /** Recorded on its runs for a World's recovery (`queueNamespace`), when it has a queue. */
  readonly executionContext?: Readonly<Record<string, unknown>>;
}

export function runIdOf(kind: EntityKind, key: string): string {
  const ulid = new RegExp(`^${kind.kind}_([0-9A-Z]{26})$`).exec(key)?.[1];
  if (ulid === undefined) throw new Error(`"${key}" isn't a ${kind.kind} key a World can hold.`);
  return `wrun_${ulid}`;
}

export function keyOfRun(kind: EntityKind, runId: string): string | undefined {
  const ulid = /^wrun_([0-9A-Z]{26})$/.exec(runId)?.[1];
  return ulid === undefined ? undefined : `${kind.kind}_${ulid}`;
}

/**
 * The stream of `key`'s run. A World names streams for its whole store, so it's named after the
 * run, as Workflow names a run's own: `strm_`, the run's ULID, `_user_`, and the namespace.
 */
export function streamNameOf(kind: EntityKind, key: string): string {
  const namespace = btoa(kind.streamNamespace)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `${runIdOf(kind, key).replace(/^wrun_/, "strm_")}_user_${namespace}`;
}

/**
 * How one writer writes one run: on a fenced run, each write is in-band at the run's in-band
 * count as this writer knows it (`seqInBand`), naming the highest position it knows of
 * (`eventCount`). Each accepted write moves both on.
 */
export interface Writer {
  readonly fenced: boolean;
  seqInBand: number;
  eventCount: number;
}

/** A journal record as the run's log keeps it. */
interface Envelope {
  /** The value. */
  readonly v: unknown;
  /** It's a snapshot: loads start from it. */
  readonly s?: true;
  /**
   * The mailbox is consumed through this message (an `EntityMessage` id); `""` on a snapshot of
   * an entity that consumed none, so a reader looking for it stops at the snapshot either way.
   */
  readonly c?: string;
}

type EventRequest = Parameters<RuntimeWorld["events"]["create"]>[1];

/** Writes `data` on `runId` as `writer`, fenced when it's fenced. */
export async function write(
  world: RuntimeWorld,
  key: string,
  runId: string,
  writer: Writer,
  data: EventRequest,
): Promise<void> {
  if (!writer.fenced) {
    await world.events.create(runId, data);
    return;
  }
  try {
    await world.events.create(
      runId,
      { ...data, specVersion: FENCED_SPEC },
      { eventCount: writer.eventCount, expectedSeqInBand: writer.seqInBand, inBand: true },
    );
  } catch (error) {
    if (isInBandSuperseded(error)) throw new TakenOverError(key, { cause: error });
    throw error;
  }
  writer.seqInBand += 1;
  writer.eventCount += 1;
}

/**
 * Creates `key`'s run with `meta` as its input, and returns its writer; `undefined` when the
 * World holds the run already.
 */
export async function createRun(
  world: RuntimeWorld,
  kind: EntityKind,
  key: string,
  meta: unknown,
): Promise<Writer | undefined> {
  const runId = runIdOf(kind, key);
  // First, as it loads a World that loads lazily, whose capabilities are known from then on.
  const deploymentId = await world.getDeploymentId();
  const fenced = world.capabilities?.inBandFence === true;
  const specVersion = fenced ? FENCED_SPEC : world.specVersion;
  try {
    await world.events.create(runId, {
      eventData: {
        deploymentId,
        input: encoder.encode(JSON.stringify(meta ?? {})),
        workflowName: kind.workflowName,
        ...(kind.executionContext !== undefined && { executionContext: kind.executionContext }),
      },
      eventType: "run_created",
      ...(specVersion !== undefined && { specVersion }),
    });
  } catch (error) {
    if (isEntityConflict(error)) return undefined;
    throw error;
  }
  if (!fenced) {
    await world.events.create(runId, { eventType: "run_started" });
    return { eventCount: 0, fenced: false, seqInBand: 0 };
  }
  // `run_created` took the run's first position, in-band.
  const writer: Writer = { eventCount: 1, fenced: true, seqInBand: 1 };
  await write(world, key, runId, writer, { eventType: "run_started" });
  return writer;
}

/** How many times a claim reads the run again when another writer moved it on meanwhile. */
const CLAIM_ATTEMPTS = 5;

/**
 * Takes `key`'s run over for this writer: reads the run's counters and writes a claim at them,
 * so a writer before it is refused from its next write. A writer still writing moves the run on
 * under a claim: the claim reads it again, so the newest claim wins. Unfenced, writes as before.
 */
export async function claimRun(world: RuntimeWorld, key: string, runId: string): Promise<Writer> {
  for (let attempt = 1; ; attempt += 1) {
    const page = await world.events.list({
      pagination: { limit: 1 },
      resolveData: "none",
      runId,
      specVersion: FENCED_SPEC,
    });
    if (page.snapshot === undefined) return { eventCount: 0, fenced: false, seqInBand: 0 };
    const writer: Writer = {
      eventCount: page.snapshot.seq,
      fenced: true,
      seqInBand: page.snapshot.seqInBand,
    };
    try {
      await appendRecord(world, key, runId, writer, {
        kind: CLAIM_RECORD,
        value: { at: Date.now() },
      });
      return writer;
    } catch (error) {
      if (!(error instanceof TakenOverError) || attempt >= CLAIM_ATTEMPTS) throw error;
    }
  }
}

/** Appends one record, as `writer`. */
export async function appendRecord(
  world: RuntimeWorld,
  key: string,
  runId: string,
  writer: Writer,
  record: JournalRecord,
  envelope: Omit<Envelope, "v"> = {},
): Promise<void> {
  const input: Envelope = { ...envelope, v: record.value };
  await write(world, key, runId, writer, {
    correlationId: `step_${createUlid()}`,
    eventData: { input: encoder.encode(JSON.stringify(input)), stepName: record.kind },
    eventType: "step_created",
  });
}

/** A journal record read back, with its envelope. */
interface Read {
  readonly record: JournalRecord;
  readonly snapshot: boolean;
  readonly consumed?: string;
}

function readOf(event: WorldEvent): Read | undefined {
  if (event.eventType !== "step_created") return undefined;
  const data = event.eventData as { readonly stepName?: unknown; readonly input?: unknown };
  if (typeof data?.stepName !== "string" || !(data.input instanceof Uint8Array)) return undefined;
  const envelope = JSON.parse(decoder.decode(data.input)) as Envelope;
  return {
    record: { kind: data.stepName, value: envelope.v },
    snapshot: envelope.s === true,
    ...(envelope.c !== undefined && { consumed: envelope.c }),
  };
}

/** Whether a record is the layer's own, which a journal's reader never sees. */
const isInternal = (record: JournalRecord) => record.kind.startsWith("entity.");

/**
 * `runId`'s journal from its latest snapshot on, and how far its mailbox is consumed as of
 * there; `undefined` for a run the World doesn't hold. Read newest first, so it costs what it
 * returns. With `untilConsumed`, it reads on past the snapshot until it finds a consumption.
 */
export async function readJournal(
  world: RuntimeWorld,
  runId: string,
  options: { readonly untilConsumed?: boolean } = {},
): Promise<(LoadedJournal & { readonly consumed: string | undefined }) | undefined> {
  const newestFirst: JournalRecord[] = [];
  let snapshot: JournalRecord | undefined;
  let consumed: string | undefined;
  let found = false;
  let cursor: string | undefined;
  do {
    let page;
    try {
      page = await world.events.list({
        pagination: { limit: LIST_PAGE, sortOrder: "desc", ...(cursor && { cursor }) },
        resolveData: "all",
        runId,
      });
    } catch (error) {
      if (isRunNotFound(error)) return undefined;
      throw error;
    }
    // A run holds its `run_created` at least: a World that lists no run as empty (the local
    // World) doesn't hold it.
    if (cursor === undefined && page.data.length === 0 && !page.hasMore) return undefined;
    for (const event of page.data) {
      const read = readOf(event);
      if (read === undefined) continue;
      if (!found && read.consumed !== undefined) {
        found = true;
        consumed = read.consumed === "" ? undefined : read.consumed;
      }
      if (snapshot === undefined) {
        if (read.snapshot) snapshot = read.record;
        else if (!isInternal(read.record)) newestFirst.push(read.record);
      }
      if (snapshot !== undefined && (found || options.untilConsumed !== true))
        return { after: newestFirst.reverse(), consumed, snapshot };
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
  return { after: newestFirst.reverse(), consumed, snapshot };
}

/** What `runId` was created with; `undefined` for a run the World doesn't hold. */
export async function readMeta(world: RuntimeWorld, runId: string): Promise<unknown> {
  let page;
  try {
    page = await world.events.list({
      pagination: { limit: 1, sortOrder: "asc" },
      resolveData: "all",
      runId,
    });
  } catch (error) {
    if (isRunNotFound(error)) return undefined;
    throw error;
  }
  const created = page.data.find((event) => event.eventType === "run_created");
  const input = (created?.eventData as { readonly input?: unknown } | undefined)?.input;
  return input instanceof Uint8Array ? JSON.parse(decoder.decode(input)) : undefined;
}

/** Every run of `kind`, newest first. */
export async function listRuns(
  world: RuntimeWorld,
  kind: EntityKind,
): Promise<readonly { readonly key: string; readonly createdAt: Date }[]> {
  const found: { key: string; createdAt: Date }[] = [];
  let cursor: string | undefined;
  do {
    const page = await world.runs.list({
      pagination: { limit: LIST_PAGE, sortOrder: "desc", ...(cursor && { cursor }) },
      resolveData: "none",
      workflowName: kind.workflowName,
    });
    for (const run of page.data) {
      const key = keyOfRun(kind, run.runId);
      if (key !== undefined && run.workflowName === kind.workflowName)
        found.push({ createdAt: new Date(run.createdAt), key });
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
  return found;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The run that claims one occurrence of `name`: a ULID with the occurrence as its time and the
 * name hashed as the rest, so every process names the same run and only the first creates it.
 * (A World refuses run ids from more than a day ago, so a run per occurrence, not one ledger.)
 */
function occurrenceRunId(name: string, occurrence: number): string {
  let time = "";
  for (let rest = occurrence, index = 0; index < 10; index += 1) {
    time = CROCKFORD[rest % 32]! + time;
    rest = Math.floor(rest / 32);
  }
  // 80 bits of FNV-1a over the name, five bits at a time.
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(name))
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & ((1n << 80n) - 1n);
  let random = "";
  for (let index = 0; index < 16; index += 1) {
    random = CROCKFORD[Number(hash & 31n)]! + random;
    hash >>= 5n;
  }
  return `wrun_${time}${random}`;
}

/** Whether this caller is the first to claim `name`'s `occurrence` (epoch milliseconds). */
export async function claimOnce(
  world: RuntimeWorld,
  name: string,
  occurrence: number,
): Promise<boolean> {
  try {
    await world.events.create(occurrenceRunId(name, occurrence), {
      eventData: {
        deploymentId: await world.getDeploymentId(),
        input: encoder.encode(JSON.stringify({ at: new Date(occurrence).toISOString(), name })),
        workflowName: "eve/entity-once",
      },
      eventType: "run_created",
    });
    return true;
  } catch (error) {
    if (isEntityConflict(error)) return false;
    throw error;
  }
}
