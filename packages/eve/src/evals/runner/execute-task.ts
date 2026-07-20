import type { Client } from "#client/client.js";
import type { HandleMessageStreamEvent, RuntimeIdentity } from "#protocol/message.js";
import { toErrorMessage } from "#shared/errors.js";
import type {
  AssertionResult,
  EveEval,
  EveEvalDerivedFacts,
  EveEvalSessionResult,
  EveEvalTargetHandle,
  EveEvalTaskResult,
  EveEvalTurn,
} from "#evals/types.js";
import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import { EvalSessionManager } from "#evals/session.js";
import { createEvalContext } from "#evals/context.js";
import { scopeEvalTargetHandle } from "#evals/target.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import { EvalRequirementFailed, EvalSkipped } from "#evals/control-flow.js";

/**
 * Options for executing one eval's task.
 */
interface ExecuteTaskOptions {
  readonly client: Client;
  readonly evaluation: EveEval;
  /** Receives each `t.log` line as it is written (used by `--verbose`). */
  readonly onLog?: (message: string) => void;
  readonly target: EveEvalTargetHandle;
  readonly timeoutMs?: number;
}

/**
 * Task result plus the assertions the eval's `test(t)` recorded. `error` is
 * set when the `test` body threw (e.g. a failed `expectOk()` or a bespoke
 * `throw`); the partial run is still captured so recorded assertions report.
 */
export interface ExecuteTaskResult {
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
  const collector = new AssertionCollector();
  const manager = new EvalSessionManager({ client, collector, signal });
  const targetForRun = scopeEvalTargetHandle(target, {
    sessions: manager,
  });

  const logs: string[] = [];
  const { context } = createEvalContext({
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
    await evaluation.test(context);
  } catch (err) {
    if (err instanceof EvalSkipped) {
      skipReason = err.reason;
    } else if (!(err instanceof EvalRequirementFailed)) {
      error = toErrorMessage(err);
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
  };
}

function combineDerivedFacts(sessions: readonly EveEvalSessionResult[]): EveEvalDerivedFacts {
  if (sessions.length === 0) return createEmptyDerivedFacts();

  const toolCalls = sessions.flatMap((session) => session.derived.toolCalls);
  const subagentCalls = sessions.flatMap((session) => session.derived.subagentCalls);
  const inputRequests = sessions.flatMap((session) => session.derived.inputRequests);
  const failureCode = sessions.find((session) => session.derived.failureCode !== undefined)?.derived
    .failureCode;

  return {
    toolCalls,
    toolCallCount: toolCalls.length,
    subagentCalls,
    subagentCallCount: subagentCalls.length,
    inputRequests,
    parked: sessions.some((session) => session.derived.parked),
    messageCount: sum(sessions, (session) => session.derived.messageCount),
    reasoningBlockCount: sum(sessions, (session) => session.derived.reasoningBlockCount),
    failureCode,
  };
}

function selectPrimarySessionId(sessions: readonly EveEvalSessionResult[]): string | undefined {
  return sessions.find((session) => session.primary)?.sessionId ?? sessions[0]?.sessionId;
}

/**
 * Extracts the {@link RuntimeIdentity} from the first `session.started` event
 * in the stream, if present.
 */
function extractRuntimeIdentity(
  events: readonly HandleMessageStreamEvent[],
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
