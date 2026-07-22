import type {
  LoopTypes,
  LoopRequest,
  StepInput,
  StepResult,
  TurnDependencies,
} from "#core/types.js";

/**
 * Runs one step of intra-turn work: one generation plus the resolution of
 * its immediate requests. Reads top to bottom: generate; a finish, a wait,
 * or an observed cancellation completes the step; unresolved child requests
 * spawn — every child before anything else — and their results fold back
 * in request order as the next step's input.
 */
export async function next<Types extends LoopTypes>(
  dependencies: TurnDependencies<Types>,
  input: StepInput<Types>,
): Promise<StepResult<Types>> {
  const generated = await dependencies.generate({
    input: input.input,
    state: input.state,
    stepOrdinal: input.stepOrdinal,
  });

  if (generated.action === "done") {
    return {
      done: true,
      isError: generated.isError,
      kind: "done",
      output: generated.output,
      state: generated.state,
      usage: generated.usage,
    };
  }

  if (generated.action === "park" && generated.pendingRuntimeActionKeys === undefined) {
    return {
      authorizationNames: generated.authorizationNames,
      done: true,
      hasPendingAuthorization: generated.hasPendingAuthorization,
      hasPendingInputBatch: generated.hasPendingInputBatch,
      kind: "waiting",
      state: generated.state,
    };
  }

  if (generated.action === "cancelled") {
    return { done: true, kind: "cancelled", state: generated.state };
  }

  const requests =
    generated.action === "dispatch-workflow-runtime-actions"
      ? toLoopRequests("workflow-interrupt", generated.pendingRuntimeActionKeys)
      : generated.action === "park" && generated.pendingRuntimeActionKeys !== undefined
        ? toLoopRequests("subagent", generated.pendingRuntimeActionKeys)
        : undefined;
  if (requests !== undefined) {
    const spawned = await dependencies.spawnChildren(generated.state, requests);
    const settled = await spawned.handle.wait();

    // A cancellation observed mid-wait continues with no input: the next
    // generation observes the aborted turn and completes via `cancelled`.
    if (settled.results === "cancelled") {
      return { done: false, nextInput: undefined, state: settled.state };
    }

    return {
      done: false,
      nextInput: { kind: "runtime-action-result", results: settled.results },
      state: settled.state,
    };
  }

  return { done: false, nextInput: undefined, state: generated.state };
}

function toLoopRequests(
  kind: LoopRequest["kind"],
  keys: readonly string[],
): readonly LoopRequest[] {
  return keys.map((key) => ({ key, kind }));
}
