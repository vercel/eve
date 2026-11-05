import { isEntityConflict, isInBandSuperseded, isRunNotFound } from "#shared/run-errors.js";
import { createUlid } from "#shared/ulid.js";
import type { RuntimeWorld, WorldEvent } from "./runtime-world.js";

// How an in-process session lives on a World: one run per session, that no workflow executes.
//   - Its stream's lines are chunks of the run's stream `eve-lines`, one per line.
//   - What it continues from is a sequence of eve-named `step_created` events on the run's log,
//     each carrying one JSON value (`appendSessionEntry`).
// A session id is `session_` and a ULID; its run id is `wrun_` and the same ULID, as Workflow
// names runs, so any World accepts it.
//
// One process writes a session at a time. On a World with the in-band fence
// (`capabilities.inBandFence`), a session's run is created at spec 9 and every write to it is
// fenced (`SessionWriter`): a process that continues a session claims it first
// (`claimSessionRun`), and the World refuses the writes of any process that wrote it before
// (`SessionTakenOverError`), writing nothing for them. Runs created before, or on a World
// without the fence, are written as they were.

/** The workflow name a session's run carries, so a list of runs finds sessions. */
export const SESSION_RUN_WORKFLOW_NAME = "eve/in-process-session";

const LINES_STREAM_NAMESPACE = "ZXZlLWxpbmVz"; // base64url("eve-lines")
const LIST_PAGE = 100;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The World run that holds `sessionId`. */
export function sessionRunId(sessionId: string): string {
  const ulid = /^session_([0-9A-Z]{26})$/.exec(sessionId)?.[1];
  if (ulid === undefined) throw new Error(`"${sessionId}" isn't a session id a World can hold.`);
  return `wrun_${ulid}`;
}

/** The session a World run holds, if it's one of eve's. */
export function sessionIdOfRun(runId: string): string | undefined {
  const ulid = /^wrun_([0-9A-Z]{26})$/.exec(runId)?.[1];
  return ulid === undefined ? undefined : `session_${ulid}`;
}

/**
 * The stream holding a session's lines. A World names streams for its whole store, so it's
 * named after the run, as Workflow names a run's own: `strm_`, the run's ULID, `_user_`, and
 * the base64url of the namespace.
 */
export function sessionLinesStream(sessionId: string): string {
  return `${sessionRunId(sessionId).replace(/^wrun_/, "strm_")}_user_${LINES_STREAM_NAMESPACE}`;
}

/** The spec version a fenced session run is created at. */
const FENCED_SPEC = 9;

/**
 * How one process writes one session's log: on a fenced run, each write is in-band at the run's
 * in-band count as this writer knows it (`seqInBand`), naming the highest position it knows of
 * (`eventCount`). Each accepted write moves both on.
 */
export interface SessionWriter {
  readonly fenced: boolean;
  seqInBand: number;
  eventCount: number;
}

/** Another process continued the session: this one's writes to it are refused. */
export class SessionTakenOverError extends Error {
  override readonly name = "SessionTakenOverError";
  readonly sessionId: string;
  constructor(sessionId: string, options?: { readonly cause?: unknown }) {
    super(
      `Session "${sessionId}" was continued by another process, so this one no longer writes it.`,
      options,
    );
    this.sessionId = sessionId;
  }
}

/** Whether `error`, or one of its causes, is a `SessionTakenOverError`. */
export function isSessionTakenOver(error: unknown): boolean {
  for (let cause = error, depth = 0; cause instanceof Error && depth < 10; depth += 1) {
    if (cause instanceof SessionTakenOverError) return true;
    cause = cause.cause;
  }
  return false;
}

/**
 * Creates `sessionId`'s run and returns its writer, fenced on a World with the fence; `undefined`
 * when the World holds the run already (a session continued), which `claimSessionRun` writes.
 */
export async function ensureSessionRun(
  world: RuntimeWorld,
  sessionId: string,
  options: {
    /** Where a World's recovery re-enqueues the run (`queueNamespace`), and the like. */
    readonly executionContext?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<SessionWriter | undefined> {
  const runId = sessionRunId(sessionId);
  // First, as it loads a World that loads lazily, whose capabilities are known from then on.
  const deploymentId = await world.getDeploymentId();
  const fenced = world.capabilities?.inBandFence === true;
  const specVersion = fenced ? FENCED_SPEC : world.specVersion;
  try {
    await world.events.create(runId, {
      eventData: {
        deploymentId,
        input: encoder.encode("{}"),
        workflowName: SESSION_RUN_WORKFLOW_NAME,
        ...(options.executionContext !== undefined && {
          executionContext: options.executionContext,
        }),
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
  const writer: SessionWriter = { eventCount: 1, fenced: true, seqInBand: 1 };
  await fencedCreate(world, sessionId, writer, { eventType: "run_started", specVersion });
  return writer;
}

/** How many times a claim reads the run again when another writer moved it on meanwhile. */
const CLAIM_ATTEMPTS = 5;

/**
 * Takes `sessionId`'s run over for this process: reads the run's counters and writes a claim at
 * them, so a process that wrote the session before is refused from its next write. A process
 * still writing the session moves the run on under a claim: the claim reads it again, so the
 * newest claim wins. On a run without the fence, writes as before.
 */
export async function claimSessionRun(
  world: RuntimeWorld,
  sessionId: string,
): Promise<SessionWriter> {
  for (let attempt = 1; ; attempt += 1) {
    const page = await world.events.list({
      pagination: { limit: 1 },
      resolveData: "none",
      runId: sessionRunId(sessionId),
      specVersion: FENCED_SPEC,
    });
    if (page.snapshot === undefined) return { eventCount: 0, fenced: false, seqInBand: 0 };
    const writer: SessionWriter = {
      eventCount: page.snapshot.seq,
      fenced: true,
      seqInBand: page.snapshot.seqInBand,
    };
    try {
      await appendSessionEntry(
        world,
        sessionId,
        "eve.claim",
        { at: new Date().toISOString() },
        writer,
      );
      return writer;
    } catch (error) {
      if (!(error instanceof SessionTakenOverError) || attempt >= CLAIM_ATTEMPTS) throw error;
    }
  }
}

async function fencedCreate(
  world: RuntimeWorld,
  sessionId: string,
  writer: SessionWriter,
  data: Parameters<RuntimeWorld["events"]["create"]>[1],
): Promise<void> {
  try {
    await world.events.create(sessionRunId(sessionId), data, {
      eventCount: writer.eventCount,
      expectedSeqInBand: writer.seqInBand,
      inBand: true,
    });
  } catch (error) {
    if (isInBandSuperseded(error)) throw new SessionTakenOverError(sessionId, { cause: error });
    throw error;
  }
  writer.seqInBand += 1;
  writer.eventCount += 1;
}

/**
 * Appends one entry, `value` under the step name `kind`, to `sessionId`'s log: fenced by
 * `writer` when it's fenced, throwing `SessionTakenOverError` when another process took over.
 */
export async function appendSessionEntry(
  world: RuntimeWorld,
  sessionId: string,
  kind: string,
  value: unknown,
  writer?: SessionWriter,
): Promise<void> {
  const data = {
    correlationId: `step_${createUlid()}`,
    eventData: { input: encoder.encode(JSON.stringify(value)), stepName: kind },
    eventType: "step_created" as const,
  };
  if (writer?.fenced === true) {
    await fencedCreate(world, sessionId, writer, { ...data, specVersion: FENCED_SPEC });
    return;
  }
  await world.events.create(sessionRunId(sessionId), data);
}

/**
 * Opens an address on `sessionId`'s run: what any process sends to `token` arrives on the run's
 * log as `hook_received` (`hooks.getByToken`). Written by the session's writer, fenced like its
 * other writes. Returns the hook's id, which its arrivals name.
 */
export async function createSessionHook(
  world: RuntimeWorld,
  sessionId: string,
  token: string,
  writer?: SessionWriter,
): Promise<string> {
  const hookId = `hook_${createUlid()}`;
  const data = { correlationId: hookId, eventData: { token }, eventType: "hook_created" as const };
  if (writer?.fenced === true)
    await fencedCreate(world, sessionId, writer, { ...data, specVersion: FENCED_SPEC });
  else await world.events.create(sessionRunId(sessionId), data);
  return hookId;
}

/** One entry of a session's log. */
export interface SessionEntry {
  readonly kind: string;
  readonly value: unknown;
}

function entryOf(event: WorldEvent): SessionEntry | undefined {
  if (event.eventType !== "step_created") return undefined;
  const data = event.eventData as { readonly stepName?: unknown; readonly input?: unknown };
  if (typeof data?.stepName !== "string" || !(data.input instanceof Uint8Array)) return undefined;
  return { kind: data.stepName, value: JSON.parse(decoder.decode(data.input)) };
}

/**
 * `sessionId`'s entries, newest first, until `stop` returns true for one (included); `undefined`
 * for a session the World doesn't hold.
 */
export async function readSessionEntriesBackwards(
  world: RuntimeWorld,
  sessionId: string,
  stop: (entry: SessionEntry) => boolean,
): Promise<SessionEntry[] | undefined> {
  const entries: SessionEntry[] = [];
  let cursor: string | undefined;
  do {
    let page;
    try {
      page = await world.events.list({
        pagination: { limit: LIST_PAGE, sortOrder: "desc", ...(cursor && { cursor }) },
        resolveData: "all",
        runId: sessionRunId(sessionId),
      });
    } catch (error) {
      if (isRunNotFound(error)) return undefined;
      throw error;
    }
    for (const event of page.data) {
      const entry = entryOf(event);
      if (entry === undefined) continue;
      entries.push(entry);
      if (stop(entry)) return entries;
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
  return entries;
}

/** Every line `sessionId`'s stream holds. */
export async function readSessionLines(
  world: RuntimeWorld,
  sessionId: string,
): Promise<Uint8Array[]> {
  const runId = sessionRunId(sessionId);
  const name = sessionLinesStream(sessionId);
  const lines: Uint8Array[] = [];
  let cursor: string | undefined;
  do {
    const page = await world.streams.getChunks(runId, name, {
      limit: 1000,
      ...(cursor && { cursor }),
    });
    for (const chunk of page.data) lines.push(chunk.data);
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
  return lines;
}

/** Appends `line` to `sessionId`'s stream; it's kept once this resolves. */
export async function appendSessionLine(
  world: RuntimeWorld,
  sessionId: string,
  line: Uint8Array,
): Promise<void> {
  await world.streams.write(sessionRunId(sessionId), sessionLinesStream(sessionId), line);
}

/** Appends `lines` to `sessionId`'s stream in order, in one write where the World has one. */
export async function appendSessionLines(
  world: RuntimeWorld,
  sessionId: string,
  lines: Uint8Array[],
): Promise<void> {
  if (lines.length === 0) return;
  const runId = sessionRunId(sessionId);
  const name = sessionLinesStream(sessionId);
  if (lines.length > 1 && world.streams.writeMulti !== undefined) {
    await world.streams.writeMulti(runId, name, lines);
    return;
  }
  for (const line of lines) await world.streams.write(runId, name, line);
}

/** The sessions a World holds runs for, newest first. */
export async function listSessionRuns(
  world: RuntimeWorld,
): Promise<readonly { readonly sessionId: string; readonly createdAt: Date }[]> {
  const sessions: { sessionId: string; createdAt: Date }[] = [];
  let cursor: string | undefined;
  do {
    const page = await world.runs.list({
      pagination: { limit: LIST_PAGE, sortOrder: "desc", ...(cursor && { cursor }) },
      resolveData: "none",
      workflowName: SESSION_RUN_WORKFLOW_NAME,
    });
    for (const run of page.data) {
      const sessionId = sessionIdOfRun(run.runId);
      if (sessionId !== undefined && run.workflowName === SESSION_RUN_WORKFLOW_NAME)
        sessions.push({ createdAt: new Date(run.createdAt), sessionId });
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
  return sessions;
}
