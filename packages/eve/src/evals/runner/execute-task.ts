import type { SessionStreamEvent } from "#protocol/session-event.js";
import { runUntilAborted } from "#evals/abort.js";
import type { Client } from "#client/client.js";
import type { RuntimeIdentity } from "#protocol/message.js";
import { toErrorMessage } from "#shared/errors.js";
import { addTokenUsage, type TokenUsage } from "#shared/token-usage.js";
import type {
  AssertionResult,
  EveEval,
  EveEvalDerivedFacts,
  EveEvalSessionResult,
  EveEvalTargetHandle,
  EveEvalTaskResult,
  EveEvalTraceContext,
  EveEvalTurn,
} from "#evals/types.js";
import { createEmptyDerivedFacts, deriveRunFacts } from "#evals/runner/derive-run-facts.js";
import { EvalSessionManager } from "#evals/session-manager.js";
import type { EvalSessionStartedEvent } from "#evals/session.js";
import { createEvalContext } from "#evals/context.js";
import { scopeEvalTargetHandle, targetTools } from "#evals/target.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import { EvalRequirementFailed, EvalSkipped } from "#evals/control-flow.js";

const EVAL_TIMEOUT_CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Options for executing one eval's task.
 */
interface ExecuteTaskOptions {
  readonly client: Client;
  readonly evaluation: EveEval;
  /** Receives each `t.log` line as it is written (used by `--verbose`). */
  readonly onLog?: (message: string) => void;
  /** Receives the first trace context observed for each session. */
  readonly onSessionStart?: (event: EvalSessionStartedEvent) => void;
  /** Shared setup context; stays in the runner process. */
  readonly setupContext?: unknown;
  readonly target: EveEvalTargetHandle;
  readonly timeoutMs?: number;
}

/**
 * Task result plus the assertions the eval's `test(t)` recorded. `error` is
 * set when the `test` body threw (e.g. a failed `expectOk()` or a bespoke
 * `throw`); the partial run is still captured so recorded assertions report.
 */
interface ExecuteTaskResult {
  readonly result: EveEvalTaskResult;
  readonly assertions: readonly AssertionResult[];
  readonly error?: string;
  readonly skipReason?: string;
}

/**
 * Executes one eval's `test(t)` against an eve agent target: drives the
 * session(s), captures the run, then finalizes the recorded assertions
 * against the completed task result.
 */
export async function executeTask(options: ExecuteTaskOptions): Promise<ExecuteTaskResult> {
  const { client, evaluation, target, timeoutMs } = options;
  const signal = timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : neverAbortSignal();
  const collector = new AssertionCollector(targetTools(target));
  const manager = new EvalSessionManager({
    client,
    collector,
    onSessionStart: options.onSessionStart,
    signal,
  });
  const targetForRun = scopeEvalTargetHandle(target, {
    sessions: manager,
  });

  const logs: string[] = [];
  const { context } = createEvalContext({
    setupContext: options.setupContext,
    collector,
    manager,
    target: targetForRun,
    signal,
    judge: evaluation.judge,
    log: (message) => {
      logs.push(message);
      options.onLog?.(message);
    },
  });

  let error: string | undefined;
  let skipReason: string | undefined;
  try {
    await runUntilAborted(evaluation.test(context), signal);
    await runUntilAborted(manager.verifyStubs(), signal);
  } catch (err) {
    if (err instanceof EvalSkipped) {
      skipReason = err.reason;
    } else if (!(err instanceof EvalRequirementFailed)) {
      error = toErrorMessage(err);
    }
  }

  if (timeoutMs !== undefined && signal.aborted) {
    const cleanupResults = await manager.cleanup(
      AbortSignal.timeout(EVAL_TIMEOUT_CLEANUP_TIMEOUT_MS),
    );
    const cleanupErrors = cleanupResults.flatMap((result) =>
      result.status === "rejected" ? [toErrorMessage(result.reason)] : [],
    );
    if (cleanupErrors.length > 0) {
      const cleanupDetail = `Eval timeout cleanup failed: ${cleanupErrors.join("; ")}`;
      error = error === undefined ? cleanupDetail : `${error}\n${cleanupDetail}`;
    }
  }

  const result = buildTaskResult({
    logs,
    sessions: manager.snapshots(),
    turn: manager.lastTurnSession()?.lastTurn,
  });
  const assertions = await collector.finalize(result);

  return { result, assertions, error, skipReason };
}

function buildTaskResult(input: {
  readonly logs: readonly string[];
  readonly sessions: readonly EveEvalSessionResult[];
  readonly turn: EveEvalTurn | undefined;
}): EveEvalTaskResult {
  const events = input.sessions.flatMap((session) => session.events);
  const finalMessage = input.turn?.message ?? null;
  return {
    output: input.turn?.data === undefined ? finalMessage : input.turn.data,
    finalMessage,
    sessionId: selectPrimarySessionId(input.sessions),
    status: input.turn?.status ?? "completed",
    events,
    logs: input.logs,
    derived: combineDerivedFacts(input.sessions),
    sessions: input.sessions,
    runtimeIdentity: extractRuntimeIdentity(events),
    traceContexts: collectTraceContexts(input.sessions),
  };
}

function collectTraceContexts(
  sessions: readonly EveEvalSessionResult[],
): readonly EveEvalTraceContext[] {
  return sessions.flatMap((session) => {
    const sessionId = session.sessionId;
    if (sessionId === undefined) return [];
    return session.traceContexts.map((traceContext) => ({
      ...traceContext,
      primary: session.primary,
      sessionId,
    }));
  });
}

/**
 * Each session's facts once. Handles that read the same session, such as a turn watched after
 * the handle that sent it, saw parts of one stream: a call one requested, another settled. Their
 * events merge by position before facts are derived.
 */
function derivedBySession(
  sessions: readonly EveEvalSessionResult[],
): readonly EveEvalSessionResult["derived"][] {
  const groups: EveEvalSessionResult[][] = [];
  const byId = new Map<string, EveEvalSessionResult[]>();
  for (const session of sessions) {
    const group = session.sessionId === undefined ? undefined : byId.get(session.sessionId);
    if (group !== undefined) {
      group.push(session);
      continue;
    }
    const created = [session];
    groups.push(created);
    if (session.sessionId !== undefined) byId.set(session.sessionId, created);
  }
  return groups.map((group) => {
    if (group.length === 1) return group[0]!.derived;
    const byPosition = new Map<string, SessionStreamEvent>();
    for (const session of group) {
      for (const event of session.events) {
        const { index, line } = event.meta.position;
        byPosition.set(`${line}:${index}`, event);
      }
    }
    const events = [...byPosition.values()].sort(
      (a, b) =>
        a.meta.position.line - b.meta.position.line ||
        a.meta.position.index - b.meta.position.index,
    );
    return deriveRunFacts(events, { sessionId: group[0]!.sessionId });
  });
}

function combineDerivedFacts(sessions: readonly EveEvalSessionResult[]): EveEvalDerivedFacts {
  if (sessions.length === 0) return createEmptyDerivedFacts();

  const derived = derivedBySession(sessions);
  const toolCalls = derived.flatMap((facts) => facts.toolCalls);
  const skillLoads = derived.flatMap((facts) => facts.skillLoads);
  const subagentCalls = derived.flatMap((facts) => facts.subagentCalls);
  const inputRequests = derived.flatMap((facts) => facts.inputRequests);
  const failureCode = sessions.find((session) => session.derived.failureCode !== undefined)?.derived
    .failureCode;

  return {
    toolCalls,
    toolCallCount: toolCalls.length,
    skillLoads,
    subagentCalls,
    subagentCallCount: subagentCalls.length,
    inputRequests,
    parked: sessions.some((session) => session.derived.parked),
    messageCount: sum(sessions, (session) => session.derived.messageCount),
    reasoningBlockCount: sum(sessions, (session) => session.derived.reasoningBlockCount),
    models: [...new Set(sessions.flatMap((session) => session.derived.models))],
    usage: evalUsage(sessions),
    failureCode,
  };
}

/**
 * The eval's usage: each captured session's latest usage, counted once however often the eval
 * captured it, less the sessions another captured session opened, whose spend that session already
 * counts. No usage when a counted session reported none.
 */
function evalUsage(sessions: readonly EveEvalSessionResult[]): TokenUsage | undefined {
  const opened = new Set(
    sessions.flatMap((session) =>
      session.events.flatMap((event) =>
        event.type === "child.opened" ? [event.data.sessionId] : [],
      ),
    ),
  );
  const latestById = new Map(sessions.map((session) => [session.sessionId, session.derived.usage]));
  const counted = [...latestById].flatMap(([id, usage]) =>
    id !== undefined && opened.has(id) ? [] : [usage],
  );
  if (!counted.every((usage): usage is TokenUsage => usage !== undefined)) return undefined;
  return counted.reduce(addTokenUsage);
}

function selectPrimarySessionId(sessions: readonly EveEvalSessionResult[]): string | undefined {
  return sessions.find((session) => session.primary)?.sessionId ?? sessions[0]?.sessionId;
}

/**
 * Extracts the {@link RuntimeIdentity} from the first `session.started` event
 * in the stream, if present.
 */
function extractRuntimeIdentity(
  events: readonly SessionStreamEvent[],
): RuntimeIdentity | undefined {
  for (const event of events) {
    if (event.type === "session.started" && event.data.runtime !== undefined) {
      return event.data.runtime;
    }
  }

  return undefined;
}

function sum<T>(entries: readonly T[], read: (entry: T) => number): number {
  return entries.reduce((total, entry) => total + read(entry), 0);
}

function neverAbortSignal(): AbortSignal {
  return new AbortController().signal;
}
