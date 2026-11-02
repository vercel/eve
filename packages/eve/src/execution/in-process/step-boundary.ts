import {
  dehydrateStepArguments,
  hydrateStepArguments,
} from "#compiled/@workflow/core/serialization.js";

// What crosses a step in a deployment goes through Workflow's serializer, which keeps some values
// and changes or refuses others. An in-process session passes its step data through the same
// serializer, so a test here sees what a deployment would; it's never stored. Services a step
// is handed, such as its stream or signals, cross as they are.

const IN_PROCESS_RUN_ID = "in-process";

/** `value` as the step on the other side of a boundary would receive it. */
export async function acrossStepBoundary<T>(value: T): Promise<T> {
  const serialized = await dehydrateStepArguments(value, IN_PROCESS_RUN_ID, undefined);
  return (await hydrateStepArguments(serialized, IN_PROCESS_RUN_ID, undefined)) as T;
}
