import {
  type DurableSession,
  type DurableSessionState,
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import type { SessionStepState } from "#execution/publish-session-events.js";
import {
  type SessionStateTransition,
  withSessionStateDelta,
} from "#execution/session/state-delta.js";
import { readTaskTable } from "#execution/tasks/table.js";
import { ignoreGoneTarget } from "#execution/tasks/workflow-target.js";
import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import { readHitlState } from "#harness/hitl/index.js";
import { storedProjection } from "#harness/session-machine/view.js";
import {
  getSessionUsageGrant,
  resetSessionUsageWindow,
  type TokenUsageDelta,
} from "#harness/turn-tag-state.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { createLogger, logError } from "#internal/logging.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { openInputs } from "#protocol/session-projection.js";

// A Continue on a session-limit prompt raises the allowance of every session
// in the tree that asked. Each session the answer passes through starts a new
// window and pushes `USAGE_CONTINUED` down to its runs, which pass it to the
// sessions they opened. The push is best-effort: a session that misses it asks
// once itself. It carries no principal, so it never starts a turn or changes
// a turn's auth.

const log = createLogger("eve:session-usage");

const USAGE_FIELDS = [
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
  "inputTokens",
  "outputTokens",
] as const;
type UsageCredit = Record<(typeof USAGE_FIELDS)[number], number>;
const NO_USAGE: UsageCredit = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/**
 * Starts a new usage window at the session's totals plus what its open relayed
 * session-limit prompts show was spent and not yet reported, so that spend
 * counts once, in the window being approved. A prompt's total less what this
 * session counted from the run that relayed it never exceeds that run's
 * unreported spend, so the credit can fall short, never overshoot. Only task
 * runs report usage up, so only their prompts earn credit.
 */
export function continueSessionUsage(
  session: DurableSession,
  grant: readonly string[],
): DurableSession {
  const relays = readHitlState(session.state).relays;
  const tasks = readTaskTable(session.state).tasks;
  const byRun = new Map<string, UsageCredit>();
  for (const { request } of openInputs(storedProjection(session.state))) {
    const relay = relays.get(request.requestId);
    if (request.kind !== "session-limit" || relay?.runId === undefined) continue;
    const run = tasks.find((task) => task.run?.runId === relay.runId)?.run;
    if (run === undefined) continue;
    const total = request.action.input["total"] as TokenUsageDelta | undefined;
    // Prompts relayed through one run can share spend, so the run's credit is
    // its largest prompt, not their sum.
    const credit = byRun.get(relay.runId) ?? { ...NO_USAGE };
    for (const field of USAGE_FIELDS) {
      const left = Math.max(0, (total?.[field] ?? 0) - (run.usage?.[field] ?? 0));
      credit[field] = Math.max(credit[field], left);
    }
    byRun.set(relay.runId, credit);
  }
  const unreported = { ...NO_USAGE };
  for (const credit of byRun.values()) {
    for (const field of USAGE_FIELDS) unreported[field] += credit[field];
  }
  const { costUsd, ...tokens } = unreported;
  return resetSessionUsageWindow(session, grant, costUsd > 0 ? unreported : tokens);
}

/**
 * Tells the session's started task runs and blocking workflow tool runs about
 * the Continue that started its current window.
 */
export async function pushSessionUsageContinuation(session: DurableSession): Promise<void> {
  const message: WorkflowToolRunControlMessage = {
    kind: "usage-continued",
    requestIds: getSessionUsageGrant(session),
  };
  const runs = [
    ...readTaskTable(session.state).tasks.flatMap((task) => (task.run?.started ? [task.run] : [])),
    ...getBlockingWorkflowToolRuns(session.state).map((run) => run.address),
  ];
  await Promise.all(
    runs.map((run) =>
      ignoreGoneTarget(resumeHook(run.hookToken, message)).catch((error: unknown) => {
        logError(log, "usage continuation not delivered", error, { runId: run.runId });
      }),
    ),
  );
}

/**
 * Applies a continuation pushed from above, passes it on, and answers the
 * session's own open session-limit prompts with Continue: the new window
 * starts at the session's totals, so they no longer hold.
 */
export async function applySessionUsageContinuationStep(
  input: SessionStepState & { readonly requestIds: readonly string[] },
): Promise<SessionStateTransition & { readonly approved: readonly string[] }> {
  "use step";
  return await withSessionStateDelta(input, async (state) => {
    const current = readDurableSession(state.sessionState);
    const session = continueSessionUsage(current, input.requestIds);
    if (session === current) return { approved: [], sessionState: state.sessionState };
    await pushSessionUsageContinuation(session);
    const relays = readHitlState(session.state).relays;
    return {
      approved: openInputs(storedProjection(session.state))
        .filter(({ request }) => request.kind === "session-limit" && !relays.has(request.requestId))
        .map(({ request }) => request.requestId),
      sessionState: replaceDurableSessionSnapshot({ session, state: state.sessionState }),
    };
  });
}

/** Tells the session's runs about a Continue it applied in a turn step. */
export async function pushSessionUsageContinuationStep(input: {
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";
  await pushSessionUsageContinuation(readDurableSession(input.sessionState));
}
