import type { RunInput } from "#channel/types.js";
import type { QueueWorld, WorldEvent } from "#execution/world/runtime-world.js";
import {
  appendSessionEntry,
  createSessionHook,
  ensureSessionRun,
  sessionIdOfRun,
  sessionRunId,
} from "#execution/world/session-runs.js";
import { isHookNotFound } from "#shared/run-errors.js";
import { wakeSession, WORLD_HOST_EXECUTION_CONTEXT } from "./wake.js";

// A World host's session as the World holds it before anything runs it, and its addresses.
//   - Starting a session creates its run and writes what it starts from (`eve.start`: the
//     agent's name and the run input), then a hook for each of its addresses, and wakes it. The
//     process that runs it later starts it from there, under the same id.
//   - Sending to an address, from any process, resolves its token to the session's run
//     (`hooks.getByToken`), writes the payload on the run's log as `hook_received`, and wakes the
//     session. The process that runs it reads what arrived (`arrivals`) and hands each to the
//     session's address there, where the session keeps it before reading it.

const START_ENTRY = "eve.start";
const LOG_PAGE = 100;
const RUN_SPEC_VERSION = 9;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What a World host's session starts from. */
export interface SessionStart {
  /** The agent's name, which the host that runs the session finds it by. */
  readonly agent: string;
  readonly input: RunInput;
}

/**
 * Creates `sessionId`'s run on `world`, with what it starts from and an address for each of
 * `tokens`, then wakes it. Nothing runs it here.
 */
export async function createWorldSession(
  world: QueueWorld,
  sessionId: string,
  start: SessionStart,
  tokens: readonly string[],
): Promise<void> {
  const writer = await ensureSessionRun(world, sessionId, {
    executionContext: WORLD_HOST_EXECUTION_CONTEXT,
  });
  if (writer === undefined) throw new Error(`The World holds a session "${sessionId}" already.`);
  await appendSessionEntry(world, sessionId, START_ENTRY, start, writer);
  for (const token of new Set(tokens)) await createSessionHook(world, sessionId, token, writer);
  await wakeSession(world, sessionId);
}

/** The session holding the address `token`, if a session on `world` does. */
export async function sessionAt(world: QueueWorld, token: string): Promise<string | undefined> {
  try {
    return sessionIdOfRun((await world.hooks.getByToken(token)).runId);
  } catch (error) {
    if (isHookNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * Sends `payload` to the session holding `token`: kept on its run's log, then the session woken.
 * The session it reached, or `undefined` when no session holds `token`.
 */
export async function sendToAddress(
  world: QueueWorld,
  token: string,
  payload: unknown,
): Promise<{ readonly sessionId: string } | undefined> {
  let hook;
  try {
    hook = await world.hooks.getByToken(token);
  } catch (error) {
    if (isHookNotFound(error)) return undefined;
    throw error;
  }
  const sessionId = sessionIdOfRun(hook.runId);
  if (sessionId === undefined) return undefined;
  await world.events.create(hook.runId, {
    correlationId: hook.hookId,
    eventData: { payload: encoder.encode(JSON.stringify(payload)) },
    eventType: "hook_received",
    specVersion: RUN_SPEC_VERSION,
  });
  await wakeSession(world, sessionId);
  return { sessionId };
}

/** One payload sent to one of a session's addresses. */
export interface Arrival {
  readonly eventId: string;
  readonly token: string;
  readonly payload: unknown;
}

/** What `sessionId`'s run holds of its start, its addresses, and what arrived at them. */
export interface SessionLog {
  readonly start: SessionStart | undefined;
  /** Every arrival, in the order the World kept them. */
  readonly arrivals: readonly Arrival[];
}

/** Reads `sessionId`'s start and arrivals from its run's log, oldest first. */
export async function readSessionLog(world: QueueWorld, sessionId: string): Promise<SessionLog> {
  const runId = sessionRunId(sessionId);
  const tokens = new Map<string, string>();
  const arrivals: Arrival[] = [];
  let start: SessionStart | undefined;
  let cursor: string | undefined;
  do {
    const page = await world.events.list({
      pagination: { limit: LOG_PAGE, sortOrder: "asc", ...(cursor && { cursor }) },
      resolveData: "all",
      runId,
    });
    for (const event of page.data) {
      start ??= startOf(event);
      const data = event.eventData as Record<string, unknown> | undefined;
      if (event.eventType === "hook_created" && typeof data?.token === "string")
        tokens.set(event.correlationId ?? "", data.token);
      if (event.eventType === "hook_received") {
        const token = tokens.get(event.correlationId ?? "");
        const payload = data?.payload;
        if (token !== undefined && payload instanceof Uint8Array)
          arrivals.push({
            eventId: event.eventId,
            payload: JSON.parse(decoder.decode(payload)),
            token,
          });
      }
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
  return { arrivals, start };
}

function startOf(event: WorldEvent): SessionStart | undefined {
  if (event.eventType !== "step_created") return undefined;
  const data = event.eventData as { readonly stepName?: unknown; readonly input?: unknown };
  if (data?.stepName !== START_ENTRY || !(data.input instanceof Uint8Array)) return undefined;
  return JSON.parse(decoder.decode(data.input)) as SessionStart;
}
