import { call, type CallStarted, type SessionView } from "eve/events";

/**
 * Returns the background task ID when a `run_browser` call starts its browser
 * worker. The model refers to that task by this ID in later replies.
 */
export function startedBrowserTaskId(event: CallStarted, view: SessionView) {
  const { callId, taskId } = event.data;
  if (!taskId) return undefined;
  const started = call(view, callId);
  return started?.kind === "tool" && started.name === "run_browser"
    ? taskId
    : undefined;
}
