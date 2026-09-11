export const SERIALIZED_INSTRUMENTATION_STATE_KEYS = {
  activeChannelDeliveries: "eve.activeChannelDeliveries",
  actionScopes: "eve.harness.instrumentationActionScopes",
  inputScopes: "eve.harness.instrumentationInputScopes",
  providerState: "eve.harness.instrumentationState",
} as const;

const SERIALIZED_AGENT_TRACE_STATE_KEY = "eve.harness.agentTrace";

/** Keeps instrumentation state needed to settle operations opened by a discarded step. */
export function preserveSerializedInstrumentationState(
  original: Record<string, unknown>,
  interrupted: Record<string, unknown>,
): Record<string, unknown> {
  let preserved = original;
  for (const key of Object.values(SERIALIZED_INSTRUMENTATION_STATE_KEYS)) {
    const state = interrupted[key];
    if (state !== undefined) preserved = { ...preserved, [key]: state };
  }
  return preserved;
}

/** Keeps only the observability state a retained background task needs before readiness. */
export function preserveSerializedBackgroundTaskObservabilityState(
  original: Record<string, unknown>,
  completed: Record<string, unknown>,
  tasks: readonly { readonly taskId: string }[],
): Record<string, unknown> {
  const taskIds = new Set(tasks.map((task) => task.taskId));
  const completedActions = asRecord(completed[SERIALIZED_INSTRUMENTATION_STATE_KEYS.actionScopes]);
  const actions = Object.fromEntries(
    Object.entries(completedActions).filter(([, value]) => {
      const action = asRecord(value);
      return typeof action["taskId"] === "string" && taskIds.has(action["taskId"]);
    }),
  );
  const actionIds = new Set(Object.keys(actions));
  if (actionIds.size === 0) return original;

  let preserved = mergeSerializedRecord(
    original,
    SERIALIZED_INSTRUMENTATION_STATE_KEYS.actionScopes,
    actions,
  );
  const providerState = Object.fromEntries(
    Object.entries(asRecord(completed[SERIALIZED_INSTRUMENTATION_STATE_KEYS.providerState])).filter(
      ([key]) => {
        const separator = key.indexOf("\0");
        return separator >= 0 && actionIds.has(key.slice(separator + 1));
      },
    ),
  );
  preserved = mergeSerializedRecord(
    preserved,
    SERIALIZED_INSTRUMENTATION_STATE_KEYS.providerState,
    providerState,
  );

  const completedTrace = asRecord(completed[SERIALIZED_AGENT_TRACE_STATE_KEY]);
  const traceActionAnchors = selectEntries(completedTrace["actionAnchors"], actionIds);
  const traceActions = Object.fromEntries(
    Object.entries(asRecord(completedTrace["actions"])).filter(([key]) => actionIds.has(key)),
  );
  const retainedCallIds = new Set<string>();
  for (const value of [...Object.values(traceActionAnchors), ...Object.values(traceActions)]) {
    const callId = asRecord(value)["callId"];
    if (typeof callId === "string") retainedCallIds.add(callId);
  }
  const traceInvocations = selectOwnedInvocations(
    completedTrace["invocations"],
    actionIds,
    retainedCallIds,
  );
  if (
    Object.keys(traceActionAnchors).length === 0 &&
    Object.keys(traceActions).length === 0 &&
    Object.keys(traceInvocations).length === 0
  ) {
    return preserved;
  }
  const originalTrace = asRecord(original[SERIALIZED_AGENT_TRACE_STATE_KEY]);
  return {
    ...preserved,
    [SERIALIZED_AGENT_TRACE_STATE_KEY]: {
      actionAnchors: {
        ...asRecord(originalTrace["actionAnchors"]),
        ...traceActionAnchors,
      },
      actions: { ...asRecord(originalTrace["actions"]), ...traceActions },
      invocations: {
        ...asRecord(originalTrace["invocations"]),
        ...traceInvocations,
      },
      sessions: asRecord(originalTrace["sessions"]),
      turns: asRecord(originalTrace["turns"]),
    },
  };
}

function selectEntries(value: unknown, keys: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(asRecord(value)).filter(([key]) => keys.has(key)));
}

function selectOwnedInvocations(
  value: unknown,
  actionIds: ReadonlySet<string>,
  retainedCallIds: Set<string>,
): Record<string, unknown> {
  const pending = Object.entries(asRecord(value));
  const selected: Record<string, unknown> = {};
  let found = true;
  while (found) {
    found = false;
    for (let index = pending.length - 1; index >= 0; index--) {
      const [key, candidate] = pending[index]!;
      const invocation = asRecord(candidate);
      const parentActionCallId = invocation["parentActionCallId"];
      if (
        !actionIds.has(key) &&
        !(typeof parentActionCallId === "string" && retainedCallIds.has(parentActionCallId))
      ) {
        continue;
      }
      selected[key] = candidate;
      const callId = invocation["callId"];
      if (typeof callId === "string") retainedCallIds.add(callId);
      pending.splice(index, 1);
      found = true;
    }
  }
  return selected;
}

function mergeSerializedRecord(
  context: Record<string, unknown>,
  key: string,
  entries: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(entries).length === 0) return context;
  return {
    ...context,
    [key]: { ...asRecord(context[key]), ...entries },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
