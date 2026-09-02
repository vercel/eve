import type { ChannelAdapter } from "#channel/adapter.js";
import { forwardLocalTaskUpdateStep } from "#execution/tasks/child/update-step.js";
import { fireTaskUpdateCallbackStep } from "#subagents/callback-step.js";
import { isSubagentAdapterState, SUBAGENT_ADAPTER_KIND } from "#subagents/adapter-state.js";
import type { TaskInboundUpdate } from "#tasks/types.js";

/** Delivers a task update through the local child adapter or remote callback. */
export async function deliverTaskUpdate(input: {
  readonly adapter?: ChannelAdapter;
  readonly callback: unknown;
  readonly update: TaskInboundUpdate;
}): Promise<string | undefined> {
  const state = input.adapter?.state;
  if (
    input.adapter?.kind === SUBAGENT_ADAPTER_KIND &&
    isSubagentAdapterState(state) &&
    state.taskId !== undefined
  ) {
    await forwardLocalTaskUpdateStep({
      parentContinuationToken: state.parentContinuationToken,
      update: input.update,
    });
    return state.taskId;
  }
  return await fireTaskUpdateCallbackStep({
    callback: input.callback,
    callId: input.update.callId,
    message: input.update.message,
    updateEpoch: input.update.updateEpoch,
    updateIndex: input.update.updateIndex,
  });
}
