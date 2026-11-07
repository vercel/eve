import type { JournalRecord, LoadedJournal } from "#execution/entity/entities.js";
import type { RuntimeWorld, WorldEvent } from "#execution/world/runtime-world.js";
import { isEntityConflict, isRunNotFound } from "#shared/run-errors.js";
import { createUlid } from "#shared/ulid.js";

// An entity on today's Worlds: one run, that no workflow executes.
//   - Its key is `<kind>_` and a ULID; its run is `wrun_` and the same ULID, as Workflow names
//     runs, so any World accepts it. What it was created with is the run's input.
//   - Its journal is `step_created` events on the run's log, the record's kind as the step's name
//     and an envelope as its input: the value, and whether it's a snapshot (`Envelope`).

const LIST_PAGE = 100;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** How one kind of entity sits on a World. */
export interface EntityKind {
  /** The keys' prefix: `session` keys are `session_<ULID>`. */
  readonly kind: string;
  /** The workflow name its runs carry, so a list of runs finds them. */
  readonly workflowName: string;
  /** The namespace its stream's name carries (base64url-encoded). */
  readonly streamNamespace: string;
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

/** A journal record as the run's log keeps it. */
interface Envelope {
  /** The value. */
  readonly v: unknown;
  /** It's a snapshot: loads start from it. */
  readonly s?: true;
}

/** Creates `key`'s run with `meta` as its input; `false` when the World holds the run already. */
export async function createRun(
  world: RuntimeWorld,
  kind: EntityKind,
  key: string,
  meta: unknown,
): Promise<boolean> {
  const runId = runIdOf(kind, key);
  try {
    await world.events.create(runId, {
      eventData: {
        deploymentId: await world.getDeploymentId(),
        input: encoder.encode(JSON.stringify(meta ?? {})),
        workflowName: kind.workflowName,
      },
      eventType: "run_created",
      ...(world.specVersion !== undefined && { specVersion: world.specVersion }),
    });
  } catch (error) {
    if (isEntityConflict(error)) return false;
    throw error;
  }
  await world.events.create(runId, { eventType: "run_started" });
  return true;
}

/** Appends one record. */
export async function appendRecord(
  world: RuntimeWorld,
  runId: string,
  record: JournalRecord,
  envelope: Omit<Envelope, "v"> = {},
): Promise<void> {
  const input: Envelope = { ...envelope, v: record.value };
  await world.events.create(runId, {
    correlationId: `step_${createUlid()}`,
    eventData: { input: encoder.encode(JSON.stringify(input)), stepName: record.kind },
    eventType: "step_created",
  });
}

/** A journal record read back, with its envelope. */
interface Read {
  readonly record: JournalRecord;
  readonly snapshot: boolean;
}

function readOf(event: WorldEvent): Read | undefined {
  if (event.eventType !== "step_created") return undefined;
  const data = event.eventData as { readonly stepName?: unknown; readonly input?: unknown };
  if (typeof data?.stepName !== "string" || !(data.input instanceof Uint8Array)) return undefined;
  const envelope = JSON.parse(decoder.decode(data.input)) as Envelope;
  return { record: { kind: data.stepName, value: envelope.v }, snapshot: envelope.s === true };
}

/**
 * `runId`'s journal from its latest snapshot on; `undefined` for a run the World doesn't hold.
 * Read newest first, so it costs what it returns.
 */
export async function readJournal(
  world: RuntimeWorld,
  runId: string,
): Promise<LoadedJournal | undefined> {
  const newestFirst: JournalRecord[] = [];
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
      if (read.snapshot) return { after: newestFirst.reverse(), snapshot: read.record };
      newestFirst.push(read.record);
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
  return { after: newestFirst.reverse(), snapshot: undefined };
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
