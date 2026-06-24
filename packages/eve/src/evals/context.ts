import type { SendTurnInput } from "#client/types.js";
import { EvalSessionManager } from "#evals/session.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import * as RunAssertions from "#evals/assertions/run.js";
import { buildJudgeContext } from "#evals/judge.js";
import type {
  Assertion,
  AssertionHandle,
  EveEvalContext,
  EveEvalJudgeConfig,
  EveEvalTargetHandle,
} from "#evals/types.js";

/**
 * Builds the `EveEvalContext` (`t`) for one eval run, wiring the session
 * manager (driving), the assertion collector (recording), and the judge
 * namespace. Returns the collector so the runner can {@link
 * AssertionCollector.finalize} it against the completed task result.
 */
export function createEvalContext(deps: {
  readonly manager: EvalSessionManager;
  readonly target: EveEvalTargetHandle;
  readonly signal: AbortSignal;
  readonly judge: EveEvalJudgeConfig | undefined;
  readonly log: (message: string) => void;
}): { readonly context: EveEvalContext; readonly collector: AssertionCollector } {
  const collector = new AssertionCollector();
  let lastPrompt = "";

  const primary = () => deps.manager.primary;
  const replyMessage = () => deps.manager.lastTurnSession()?.lastTurn?.message ?? null;

  const judge = buildJudgeContext({
    collector,
    getReply: replyMessage,
    getInput: () => lastPrompt,
    judge: deps.judge,
  });

  const context: EveEvalContext = {
    // EveEvalSession — drive the primary session.
    get events() {
      return primary().events;
    },
    get pendingInputRequests() {
      return primary().pendingInputRequests;
    },
    get state() {
      return primary().state;
    },
    get sessionId() {
      return primary().sessionId;
    },
    expectInputRequests: (filter) => primary().expectInputRequests(filter),
    respond: (...responses) => primary().respond(...responses),
    respondAll: (optionId) => primary().respondAll(optionId),
    send: (input) => {
      lastPrompt = promptText(input);
      return primary().send(input);
    },
    sendFile: (text, filePath, mediaType) => {
      lastPrompt = text;
      return primary().sendFile(text, filePath, mediaType);
    },

    // Run context.
    signal: deps.signal,
    target: deps.target,
    get reply() {
      return replyMessage();
    },
    log: deps.log,
    sleep: (ms) => sleep(ms, deps.signal),
    newSession: () => deps.manager.newSession(),

    // Run-level assertions (lazy; default gate).
    completed: () => collector.recordRun(RunAssertions.completed()),
    didNotFail: () => collector.recordRun(RunAssertions.didNotFail()),
    waiting: () => collector.recordRun(RunAssertions.waiting()),
    messageIncludes: (token) => collector.recordRun(RunAssertions.messageIncludes(token)),
    calledTool: (name, options) => collector.recordRun(RunAssertions.calledTool(name, options)),
    loadedSkill: (skill, options) => collector.recordRun(RunAssertions.loadedSkill(skill, options)),
    notCalledTool: (name) => collector.recordRun(RunAssertions.notCalledTool(name)),
    toolOrder: (names) => collector.recordRun(RunAssertions.toolOrder(names)),
    usedNoTools: () => collector.recordRun(RunAssertions.usedNoTools()),
    maxToolCalls: (max) => collector.recordRun(RunAssertions.maxToolCalls(max)),
    calledSubagent: (name, options) =>
      collector.recordRun(RunAssertions.calledSubagent(name, options)),
    noFailedActions: () => collector.recordRun(RunAssertions.noFailedActions()),
    event: (predicate, label) => collector.recordRun(RunAssertions.event(predicate, label)),
    outputEquals: (value) => collector.recordRun(RunAssertions.outputEquals(value)),
    outputMatches: (schema) => collector.recordRun(RunAssertions.outputMatches(schema)),

    // Value-level assertion over an explicit value.
    check: (value, assertion) => recordCheck(collector, value, assertion),

    judge,
  };

  return { context, collector };
}

function recordCheck(
  collector: AssertionCollector,
  value: unknown,
  assertion: Assertion,
): AssertionHandle {
  return collector.recordValue({
    name: assertion.name,
    severity: assertion.severity,
    threshold: assertion.threshold,
    score: async () => ({ score: await assertion.score(value) }),
  });
}

function promptText(input: SendTurnInput): string {
  if (typeof input === "string") return input;
  const message = (input as { readonly message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

function sleep(ms = 1_000, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error("sleep() duration must be a non-negative finite number.");
  }

  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
