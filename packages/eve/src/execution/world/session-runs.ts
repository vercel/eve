import { isEntityConflict, isRunNotFound } from "#shared/run-errors.js";
import { createUlid } from "#shared/ulid.js";
import type { RuntimeWorld, WorldEvent } from "./runtime-world.js";

// How an in-process session lives on a World: one run per session, that no workflow executes.
//   - Its stream's lines are chunks of the run's stream `eve-lines`, one per line.
//   - What it continues from is a sequence of eve-named `step_created` events on the run's log,
//     each carrying one JSON value (`appendSessionEntry`).
// A session id is `session_` and a ULID; its run id is `wrun_` and the same ULID, as Workflow
// names runs, so any World accepts it.

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

/** Creates `sessionId`'s run, unless the World holds it already (a session continued). */
export async function ensureSessionRun(world: RuntimeWorld, sessionId: string): Promise<void> {
  const runId = sessionRunId(sessionId);
  try {
    await world.events.create(runId, {
      eventData: {
        deploymentId: await world.getDeploymentId(),
        input: encoder.encode("{}"),
        workflowName: SESSION_RUN_WORKFLOW_NAME,
      },
      eventType: "run_created",
      ...(world.specVersion !== undefined && { specVersion: world.specVersion }),
    });
    await world.events.create(runId, { eventType: "run_started" });
  } catch (error) {
    if (!isEntityConflict(error)) throw error;
  }
}

/** Appends one entry, `value` under the step name `kind`, to `sessionId`'s log. */
export async function appendSessionEntry(
  world: RuntimeWorld,
  sessionId: string,
  kind: string,
  value: unknown,
): Promise<void> {
  await world.events.create(sessionRunId(sessionId), {
    correlationId: `step_${createUlid()}`,
    eventData: { input: encoder.encode(JSON.stringify(value)), stepName: kind },
    eventType: "step_created",
  });
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
