// What crosses a step in a deployment goes through its host's serializer, which keeps some values
// and changes or refuses others. An in-process session passes its step data through a boundary
// too, so its steps and hooks receive copies, as a deployment's would; nothing is stored. Services
// a step is handed, such as its stream or signals, cross as they are. A hook's payload crosses
// too, as Workflow's hook payloads do: sent where it's sent, and received where its hook is.

/** A value on its way across a boundary, as the boundary carries it. */
export interface Crossing {
  readonly carried: unknown;
}

/** How values cross a step boundary. */
export interface StepBoundary {
  /** Carries `value` across, as the side that sends it would. */
  send(value: unknown): Promise<Crossing>;
  /** What `crossing` reads as on the receiving side: a fresh copy each time. */
  receive(crossing: Crossing): Promise<unknown>;
}

/**
 * A structured clone, which every JavaScript runtime has: dates, maps and sets survive, and
 * functions are refused, as Workflow's serializer refuses them. A test that needs a deployment's
 * exact serializer passes Workflow's (`workflow-host/step-boundary.ts`).
 */
export const structuredCloneBoundary: StepBoundary = {
  send: async (value) => ({ carried: structuredClone(value) }),
  receive: async ({ carried }) => structuredClone(carried),
};

/**
 * What `crossing` reads as on the receiving side, as what that side expects: the step's own
 * input, or what its hook's token is for. Like Workflow's, a boundary doesn't check it.
 */
export async function received<T>(boundary: StepBoundary, crossing: Crossing): Promise<T> {
  return (await boundary.receive(crossing)) as T;
}

/** `value` as the step on the other side of `boundary` would receive it. */
export async function acrossStepBoundary<T>(boundary: StepBoundary, value: T): Promise<T> {
  return await received<T>(boundary, await boundary.send(value));
}
