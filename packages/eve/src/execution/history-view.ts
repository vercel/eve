import type { HarnessSession } from "#harness/types.js";
import {
  createHistoryViewPreparer,
  identityHistoryViewProjector,
  type PreparedHistoryView,
} from "#shared/history-view.js";

export interface ExecutionHistoryView {
  readonly initial: PreparedHistoryView;
  readonly messages: (session: HarnessSession) => PreparedHistoryView["messages"];
  readonly prepare: (session: HarnessSession) => PreparedHistoryView;
  readonly projector: typeof identityHistoryViewProjector;
}

export function createExecutionHistoryView(session: HarnessSession): ExecutionHistoryView {
  const projector = identityHistoryViewProjector;
  const prepareHistory = createHistoryViewPreparer({ projector });
  const prepare = (next: HarnessSession) => prepareHistory(next.history, next.state);

  return {
    initial: prepare(session),
    messages: (next) => prepare(next).messages,
    prepare,
    projector,
  };
}
