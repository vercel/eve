/**
 * Request-time descendant cancellation.
 *
 * The durable settle-time cascade
 * ({@link import("#execution/cancel-descendant-turns-step.js").cancelDescendantTurnsStep})
 * runs inside the parent's workflow, which cannot execute while the parent
 * run is suspended — including while it is parked awaiting the very child it
 * needs to cancel. A cancel request therefore fans out to descendants
 * immediately at the API boundary, before any run has to wake.
 *
 * The session's own event stream is the durable record of dispatched
 * children: `subagent.called` carries `{ callId, childSessionId,
 * remote?.url, turnId }` and `action.result` marks the call resolved. Both
 * are readable by session id from any process. Cancelling an
 * already-finished child resolves to `no_active_turn` and is harmless, so
 * the fold errs toward over-cancelling.
 */

import type { CancelTurnResult } from "#channel/types.js";
import { createLogger, logError } from "#internal/logging.js";
import { getRun } from "#internal/workflow/runtime.js";
import {
  cancelRemoteAgentTurn,
  isRetryableRemoteAgentCancelError,
} from "#execution/remote-agent-dispatch.js";
import { requestWorkflowTurnCancellation } from "#execution/turn-cancellation-request.js";
import type { RuntimeSubagentRegistry } from "#runtime/subagents/registry.js";
import type { ResolvedRuntimeRemoteAgentNode } from "#runtime/types.js";

const log = createLogger("execution.turn-cancellation-fanout");

// Fan-out runs inline in the cancel request handler, so every bound is
// small: a short per-child retry covers the dispatch gap where a child run
// exists but its cancel hook is not yet armed, and the stream read deadline
// keeps a wedged world from stalling the response. The durable settle-time
// cascade remains the backstop for anything missed here.
const FANOUT_ATTEMPTS = 3;
const FANOUT_RETRY_DELAY_MS = 250;
const MAX_DESCENDANT_DEPTH = 8;
const STREAM_READ_DEADLINE_MS = 5_000;

type RemoteRegistry = RuntimeSubagentRegistry["subagentsByNodeId"];

/** One dispatched-but-unresolved child derived from a session's events. */
export interface PendingDescendantRecord {
  readonly callId: string;
  readonly childSessionId: string;
  readonly remote?: { readonly url: string };
  readonly toolName: string;
  readonly turnId: string;
}

/**
 * Cancels a session's active turn and immediately fans the cancellation out
 * to every dispatched-but-unresolved descendant, without waiting for the
 * target's workflow run to wake. Fan-out failures are logged, never thrown:
 * the returned result reflects the target session alone.
 */
export async function cancelTurnWithDescendantFanout(input: {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly resolveRemoteRegistry?: () => Promise<RemoteRegistry>;
}): Promise<CancelTurnResult> {
  const cancelInput: { sessionId: string; turnId?: string } = { sessionId: input.sessionId };
  if (input.turnId !== undefined) cancelInput.turnId = input.turnId;
  const result = await requestWorkflowTurnCancellation(cancelInput);

  // Fan out even when the target reports no active turn: descendants that
  // outlived an earlier cancel (or a crashed parent) are exactly the ones
  // only a fresh request can still reach.
  try {
    await cancelDescendantSessions({
      depth: 0,
      resolveRemoteRegistry: input.resolveRemoteRegistry,
      sessionId: input.sessionId,
      turnId: input.turnId,
      visited: new Set([input.sessionId]),
    });
  } catch (error) {
    logError(log, "descendant cancel fan-out failed", error, { sessionId: input.sessionId });
  }

  return result;
}

/**
 * Folds a session's events into its dispatched-but-unresolved children.
 * When `turnId` is set, only children dispatched by that turn are returned;
 * malformed entries are skipped.
 */
export function collectPendingDescendants(input: {
  readonly events: Iterable<unknown>;
  readonly turnId?: string;
}): PendingDescendantRecord[] {
  const pending = new Map<string, PendingDescendantRecord>();

  for (const event of input.events) {
    if (typeof event !== "object" || event === null) continue;
    const candidate = event as { readonly data?: unknown; readonly type?: unknown };

    if (candidate.type === "subagent.called") {
      const record = parseSubagentCalledData(candidate.data);
      if (record !== undefined) pending.set(record.callId, record);
      continue;
    }

    if (candidate.type === "action.result") {
      const callId = parseActionResultCallId(candidate.data);
      if (callId !== undefined) pending.delete(callId);
    }
  }

  const records = [...pending.values()];
  return input.turnId === undefined
    ? records
    : records.filter((record) => record.turnId === input.turnId);
}

async function cancelDescendantSessions(input: {
  readonly depth: number;
  readonly resolveRemoteRegistry?: () => Promise<RemoteRegistry>;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly visited: Set<string>;
}): Promise<void> {
  if (input.depth >= MAX_DESCENDANT_DEPTH) {
    log.warn("descendant cancel fan-out hit the depth cap", {
      depth: input.depth,
      sessionId: input.sessionId,
    });
    return;
  }

  let records: PendingDescendantRecord[];
  try {
    records = collectPendingDescendants({
      events: await readSessionEventsUpToTail(input.sessionId),
      turnId: input.turnId,
    });
  } catch (error) {
    logError(log, "failed to read session events during cancel fan-out", error, {
      sessionId: input.sessionId,
    });
    return;
  }

  await Promise.all(
    records.map(async (record) => {
      if (input.visited.has(record.childSessionId)) return;
      input.visited.add(record.childSessionId);

      if (record.remote !== undefined) {
        await cancelRemoteDescendantAtRequest({
          record,
          resolveRemoteRegistry: input.resolveRemoteRegistry,
        });
        return;
      }

      await cancelLocalDescendantAtRequest(record);
      // Grandchildren are cancelled without a turn filter: whatever is still
      // unresolved under a cancelled child must not keep running.
      await cancelDescendantSessions({
        depth: input.depth + 1,
        resolveRemoteRegistry: input.resolveRemoteRegistry,
        sessionId: record.childSessionId,
        visited: input.visited,
      });
    }),
  );
}

async function cancelLocalDescendantAtRequest(record: PendingDescendantRecord): Promise<void> {
  try {
    const final = await requestCancellationWithRetry({
      request: () => requestWorkflowTurnCancellation({ sessionId: record.childSessionId }),
      shouldRetryError: () => false,
      shouldRetryResult: (result) =>
        // A child in its dispatch gap has no cancel hook yet, which is
        // indistinguishable from an already-finished child — retrying briefly
        // covers the former and only costs no-ops on the latter.
        result.status === "no_active_turn",
    });
    if (final.status !== "accepted") {
      log.info("descendant had no active turn during request-time cancel fan-out", {
        callId: record.callId,
        childSessionId: record.childSessionId,
        reason: final.reason,
        toolName: record.toolName,
      });
    }
  } catch (error) {
    logError(log, "failed to cancel local descendant at request time", error, {
      callId: record.callId,
      childSessionId: record.childSessionId,
      toolName: record.toolName,
    });
  }
}

async function cancelRemoteDescendantAtRequest(input: {
  readonly record: PendingDescendantRecord;
  readonly resolveRemoteRegistry?: () => Promise<RemoteRegistry>;
}): Promise<void> {
  const { record } = input;
  if (record.remote === undefined || input.resolveRemoteRegistry === undefined) {
    log.warn("remote descendant cannot be cancelled at request time; deferring to settle-time", {
      callId: record.callId,
      childSessionId: record.childSessionId,
      hasRegistry: input.resolveRemoteRegistry !== undefined,
      toolName: record.toolName,
    });
    return;
  }

  try {
    const remote = findRemoteAgentByUrl({
      registry: await input.resolveRemoteRegistry(),
      url: record.remote.url,
    });
    if (remote === undefined) {
      log.warn("remote descendant url matched no registered remote agent; deferring", {
        callId: record.callId,
        childSessionId: record.childSessionId,
        toolName: record.toolName,
        url: record.remote.url,
      });
      return;
    }
    const final = await requestCancellationWithRetry({
      request: () => cancelRemoteAgentTurn({ remote, sessionId: record.childSessionId }),
      shouldRetryError: isRetryableRemoteAgentCancelError,
      // The remote deployment already classified its own turn state; a
      // remote no_active_turn is terminal.
      shouldRetryResult: () => false,
    });
    if (final.status !== "accepted") {
      log.info("remote descendant had no active turn during request-time cancel fan-out", {
        callId: record.callId,
        childSessionId: record.childSessionId,
        toolName: record.toolName,
      });
    }
  } catch (error) {
    logError(log, "failed to cancel remote descendant at request time", error, {
      callId: record.callId,
      childSessionId: record.childSessionId,
      toolName: record.toolName,
    });
  }
}

async function requestCancellationWithRetry(input: {
  readonly request: () => Promise<CancelTurnResult>;
  readonly shouldRetryError: (error: unknown) => boolean;
  readonly shouldRetryResult: (result: CancelTurnResult) => boolean;
}): Promise<CancelTurnResult> {
  let lastResult: CancelTurnResult = { status: "no_active_turn" };

  for (let attempt = 1; attempt <= FANOUT_ATTEMPTS; attempt += 1) {
    try {
      lastResult = await input.request();
      if (lastResult.status === "accepted" || !input.shouldRetryResult(lastResult)) {
        return lastResult;
      }
    } catch (error) {
      if (!input.shouldRetryError(error) || attempt === FANOUT_ATTEMPTS) throw error;
    }
    if (attempt < FANOUT_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, FANOUT_RETRY_DELAY_MS * attempt));
    }
  }

  return lastResult;
}

/**
 * Reads every event currently journaled on the session's stream and stops at
 * the tail observed on entry, so a live (never-closing) run stream cannot
 * block the cancel request. Chunks map 1:1 to stream writes; each carries
 * one or more NDJSON lines.
 */
async function readSessionEventsUpToTail(sessionId: string): Promise<unknown[]> {
  const stream = getRun<unknown>(sessionId).getReadable<Uint8Array>();
  const tailIndex = await stream.getTailIndex();
  if (tailIndex < 0) {
    await stream.cancel("eve cancel fan-out: session has no events").catch(() => {});
    return [];
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buffer = "";
  let chunksRead = 0;
  let deadlineHit = false;
  const deadline = setTimeout(() => {
    deadlineHit = true;
    void reader.cancel("eve cancel fan-out: stream read deadline reached").catch(() => {});
  }, STREAM_READ_DEADLINE_MS);

  const drainBuffer = () => {
    for (
      let newlineIndex = buffer.indexOf("\n");
      newlineIndex !== -1;
      newlineIndex = buffer.indexOf("\n")
    ) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // A single undecodable line must not abort the whole fan-out.
      }
    }
  };

  try {
    while (chunksRead <= tailIndex) {
      const { done, value } = await reader.read();
      if (done) break;
      chunksRead += 1;
      buffer += decoder.decode(value, { stream: true });
      drainBuffer();
    }
    buffer += decoder.decode();
    buffer += "\n";
    drainBuffer();
  } finally {
    clearTimeout(deadline);
    await reader.cancel("eve cancel fan-out: read complete").catch(() => {});
    reader.releaseLock();
  }

  if (deadlineHit) {
    log.warn("session event read hit the fan-out deadline; descendants may be incomplete", {
      chunksRead,
      sessionId,
      tailIndex,
    });
  }

  return events;
}

function parseSubagentCalledData(data: unknown): PendingDescendantRecord | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const value = data as {
    readonly callId?: unknown;
    readonly childSessionId?: unknown;
    readonly remote?: unknown;
    readonly toolName?: unknown;
    readonly turnId?: unknown;
  };
  if (
    typeof value.callId !== "string" ||
    typeof value.childSessionId !== "string" ||
    typeof value.toolName !== "string" ||
    typeof value.turnId !== "string"
  ) {
    return undefined;
  }

  const record: {
    callId: string;
    childSessionId: string;
    remote?: { url: string };
    toolName: string;
    turnId: string;
  } = {
    callId: value.callId,
    childSessionId: value.childSessionId,
    toolName: value.toolName,
    turnId: value.turnId,
  };

  if (
    typeof value.remote === "object" &&
    value.remote !== null &&
    typeof (value.remote as { readonly url?: unknown }).url === "string"
  ) {
    record.remote = { url: (value.remote as { readonly url: string }).url };
  }

  return record;
}

/**
 * The `subagent.called` event records a remote child's dispatch URL but not
 * its registry node, so the cancel request re-resolves the node (and with it
 * the remote's auth and headers) by URL. Distinct nodes sharing a URL target
 * the same deployment, so any match cancels the same session.
 */
function findRemoteAgentByUrl(input: {
  readonly registry: RemoteRegistry;
  readonly url: string;
}): ResolvedRuntimeRemoteAgentNode | undefined {
  for (const registered of input.registry.values()) {
    const definition = registered.definition;
    if (definition.kind === "remote" && definition.url === input.url) return definition;
  }
  return undefined;
}

function parseActionResultCallId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const result = (data as { readonly result?: unknown }).result;
  if (typeof result !== "object" || result === null) return undefined;
  const callId = (result as { readonly callId?: unknown }).callId;
  return typeof callId === "string" ? callId : undefined;
}
