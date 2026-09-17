import { contextStorage, type ContextContainer } from "#context/container.js";
import type { InstrumentationHooks } from "#instrumentation/lifecycle.js";
import { publishBackgroundTaskSettlements } from "#instrumentation/native-events.js";
import { rememberInstrumentationBackgroundTaskForCall } from "#instrumentation/state.js";
import type { TaskView } from "#tasks/types.js";

export interface BackgroundTaskInstrumentation {
  readonly publishBackgroundTaskSettlements: (input: {
    readonly acceptedAtMs?: number;
    readonly views: readonly TaskView[];
  }) => Promise<void>;
  readonly rememberBackgroundTasks: (
    tasks: readonly { readonly callId?: string; readonly taskId: string }[],
  ) => void;
}

export function createBackgroundTaskInstrumentation(input: {
  readonly ctx: ContextContainer;
  readonly hooks: () => InstrumentationHooks;
  readonly sessionId: string;
}): BackgroundTaskInstrumentation {
  return {
    publishBackgroundTaskSettlements: (settlements) =>
      publishBackgroundTaskSettlements({
        ...settlements,
        hooks: input.hooks(),
      }),
    rememberBackgroundTasks: (tasks) => {
      contextStorage.run(input.ctx, () => {
        for (const task of tasks) {
          if (task.callId === undefined) continue;
          rememberInstrumentationBackgroundTaskForCall(input.sessionId, task.callId, task.taskId);
        }
      });
    },
  };
}
