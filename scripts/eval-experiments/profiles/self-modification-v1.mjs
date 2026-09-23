const agentSourcePaths = [
  "packages/eve/src/self-modification/extension/subagents/agent/instructions.ts",
  "packages/eve/src/self-modification/extension/subagents/agent/agent.ts",
];

const configurationPaths = [agentSourcePaths[1]];

export default {
  id: "self-modification-v1",
  metricSchemaVersion: "self-modification-v1",
  supportedCases: new Map([
    ["agent-self-modification", new Set(["self-modification/create-shipping-quote"])],
  ]),
  validateSelection(fixtureName, evals, knownEvals) {
    if (!Array.isArray(evals) || evals.length < 1 || evals.length > 10)
      throw new Error("Select 1–10 evals for each fixture.");
    const supported = this.supportedCases.get(fixtureName);
    if (!supported) throw new Error(`${this.id} does not support fixture ${fixtureName}.`);
    for (const id of evals) {
      if (!knownEvals.has(id)) throw new Error(`Unknown eval ${id} in ${fixtureName}`);
      if (!supported.has(id)) throw new Error(`${this.id} does not support ${fixtureName}/${id}.`);
    }
  },
  allowedDiffPaths: new Set(agentSourcePaths),
  configurationPaths: new Set(configurationPaths),
  guardedFixtureSource: "agent",
  verifyCheckoutRestored: async (appRoot) => {
    try {
      await import("node:fs/promises").then(({ stat }) =>
        stat(`${appRoot}/.eve-self-modification-eval.lock`),
      );
      return false;
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
  },
  modelSettingsPaths: {
    fixtureParent: "agent/agent.ts",
    selfModificationAgent: "packages/eve/src/self-modification/extension/subagents/agent/agent.ts",
  },
  primaryMetric: "creationElapsedMs",
  metricNames: ["creationElapsedMs", "childTurnMs", "childToolCalls"],
  targetAgent: "self-modification__agent",
  extractMeasurement({
    eventsBySession,
    parentSessionId,
    parentTurnId,
    called,
    childSessionId,
    childEvents,
  }) {
    const invocation = childEvents.find((event) => event.type === "session.started")?.data
      ?.invocation;
    if (
      !invocation ||
      invocation.kind !== "subagent" ||
      invocation.parentCallId !== called.data?.callId ||
      invocation.parentSessionId !== parentSessionId ||
      invocation.parentTurnId !== parentTurnId
    )
      return { status: "incomplete", reason: "child-invocation-mismatch" };

    const parentStart = eventsBySession
      .get(parentSessionId)
      ?.find((event) => event.type === "turn.started" && event.data?.turnId === parentTurnId);
    if (!parentStart) return { status: "incomplete", reason: "missing-parent-turn-start" };
    if (!parentStart.meta?.id || !called.meta?.id)
      return { status: "incomplete", reason: "missing-event-identity" };

    const starts = childEvents.filter((event) => event.type === "turn.started");
    const failures = childEvents.filter((event) =>
      ["turn.failed", "turn.cancelled", "session.failed"].includes(event.type),
    );
    if (failures.length) return { status: "incomplete", reason: "child-turn-failed" };
    const completions = childEvents.filter((event) => event.type === "turn.completed");
    if (starts.length !== 1 || completions.length !== 1)
      return {
        status: "incomplete",
        reason:
          starts.length > 1 || completions.length > 1
            ? "ambiguous-child-turn"
            : "missing-child-turn-boundary",
      };

    const start = starts[0];
    const completed = completions[0];
    const turnId = start.data?.turnId;
    if (!turnId || completed.data?.turnId !== turnId)
      return { status: "incomplete", reason: "child-turn-mismatch" };
    if (!start.meta?.id || !completed.meta?.id)
      return { status: "incomplete", reason: "missing-event-identity" };
    if (
      childEvents.some((item) => item.type === "input.requested" && item.data?.turnId === turnId) ||
      completed.data?.status === "waiting" ||
      childEvents.some(
        (item) =>
          item.type === "session.waiting" &&
          Date.parse(item.meta?.at ?? "") <= Date.parse(completed.meta?.at ?? ""),
      )
    )
      return { status: "incomplete", reason: "child-turn-parked" };

    const parentAt = Date.parse(parentStart.meta?.at ?? "");
    const childStartAt = Date.parse(start.meta?.at ?? "");
    const childEndAt = Date.parse(completed.meta?.at ?? "");
    if (![parentAt, childStartAt, childEndAt].every(Number.isFinite))
      return { status: "incomplete", reason: "missing-timestamp" };
    const creationElapsedMs = childEndAt - parentAt;
    const childTurnMs = childEndAt - childStartAt;
    if (creationElapsedMs < 0 || childTurnMs < 0)
      return { status: "incomplete", reason: "negative-elapsed-time" };

    const toolCalls = new Set(
      childEvents
        .filter((event) => event.type === "actions.requested")
        .flatMap((event) =>
          (event.data?.actions ?? [])
            .filter((action) => action.kind === "tool-call")
            .map((action) => action.callId)
            .filter(Boolean),
        ),
    );
    return {
      status: "complete",
      metrics: { creationElapsedMs, childTurnMs, childToolCalls: toolCalls.size },
      observedModelSettings: {
        parent: [...(eventsBySession.get(parentSessionId) ?? [])]
          .filter((event) => event.type === "step.started")
          .map((event) => event.data?.modelId)
          .filter(Boolean),
        child: childEvents
          .filter((event) => event.type === "step.started")
          .map((event) => event.data?.modelId)
          .filter(Boolean),
      },
      events: {
        parentStart: ref(parentStart),
        childStart: ref(start),
        childCompletion: ref(completed),
        delegation: ref(called),
        childSessionId,
        parentSessionId,
        callId: called.data?.callId,
      },
    };
  },
};

function ref(event) {
  return { id: event.meta?.id, at: event.meta?.at, type: event.type };
}
