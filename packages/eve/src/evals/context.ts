import type { SendTurnInput } from "#client/types.js";
import { EvalSessionManager } from "#evals/session.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import { createScopedAssertions } from "#evals/assertions/scoped.js";
import { buildJudgeContext } from "#evals/judge.js";
import { EvalRequirementFailed, EvalSkipped } from "#evals/control-flow.js";
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
  readonly collector: AssertionCollector;
  readonly target: EveEvalTargetHandle;
  readonly signal: AbortSignal;
  readonly judge: EveEvalJudgeConfig | undefined;
  readonly log: (message: string) => void;
}): { readonly context: EveEvalContext; readonly collector: AssertionCollector } {
  const collector = deps.collector;
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
    cancel: () => primary().cancel(),
    requireInputRequest: (filter) => primary().requireInputRequest(filter),
    respond: (...responses) => primary().respond(...responses),
    respondAll: (optionId) => primary().respondAll(optionId),
    send: (input) => {
      lastPrompt = promptText(input);
      return primary().send(input);
    },
    start: (input) => {
      lastPrompt = promptText(input);
      return primary().start(input);
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
    ...createScopedAssertions(collector, { timing: "final", select: (result) => result }),

    // Value-level assertion over an explicit value.
    check: (value, assertion) => recordCheck(collector, value, assertion),
    require: (value, assertion) => requireCheck(collector, value, assertion),
    skip: (reason) => {
      if (reason.trim().length === 0) throw new Error("skip() requires a non-empty reason.");
      if (collector.hasEntries || deps.manager.hasActivity()) {
        throw new Error("skip() must be called before sending messages or recording assertions.");
      }
      throw new EvalSkipped(reason);
    },

    judge,
  };

  return { context, collector };
}

async function requireCheck<T>(
  collector: AssertionCollector,
  value: T,
  assertion: Assertion,
): Promise<T> {
  const gated = assertion.gate(assertion.threshold);
  const passed = await collector.recordRequirement({
    name: gated.name,
    threshold: gated.threshold,
    score: async () => {
      return { score: await gated.score(value) };
    },
  });
  if (!passed) throw new EvalRequirementFailed();
  return value;
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
