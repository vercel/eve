import type { HarnessSession } from "#harness/types.js";
import {
  createHistoryViewPreparer,
  type HistoryViewProjector,
  type PreparedHistoryView,
} from "#shared/history-view.js";
import { projectMemoryHistoryFromSessionState } from "#shared/memory-state.js";

export interface ExecutionHistoryView {
  readonly initial: PreparedHistoryView;
  readonly messages: (session: HarnessSession) => PreparedHistoryView["messages"];
  readonly prepare: (session: HarnessSession) => PreparedHistoryView;
  readonly projector: HistoryViewProjector;
}

export function createExecutionHistoryView(session: HarnessSession): ExecutionHistoryView {
  const projector: HistoryViewProjector = projectMemoryHistoryFromSessionState;
  const prepareHistory = createHistoryViewPreparer({ projector });
  const prepare = (next: HarnessSession) => prepareHistory(next.history, next.state);

  return {
    initial: prepare(session),
    messages: (next) => prepare(next).messages,
    prepare,
    projector,
  };
}
