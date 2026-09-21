import type { MessageStreamEvent } from "eve/client";

export interface SubagentProgress {
  phase: "working" | "done" | "failed" | "cancelled" | "waiting";
  startedAt?: number;
  endedAt?: number;
  update: string;
  messageKey?: string;
  messageText?: string;
}
export const initialSubagentProgress = (): SubagentProgress => ({
  phase: "working",
  update: "Starting…",
});
export function terseUpdate(text: string) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}
export function reduceSubagentProgress(
  state: SubagentProgress,
  event: MessageStreamEvent,
): SubagentProgress {
  const parsed = Date.parse(event.meta.at);
  const at = Number.isFinite(parsed) ? parsed : undefined;
  const startedAt = state.startedAt ?? at;
  switch (event.type) {
    case "session.started":
      return { ...state, startedAt };
    case "turn.started":
      return {
        phase: "working",
        startedAt: state.endedAt === undefined ? startedAt : at,
        update: "Thinking…",
      };
    case "step.started":
      return {
        ...state,
        phase: "working",
        endedAt: undefined,
        startedAt,
        update: state.update === "Starting…" ? "Thinking…" : state.update,
      };
    case "action.input.appended":
      return { ...state, startedAt, update: `Preparing ${event.data.toolName}` };
    case "actions.requested": {
      const action = event.data.actions.at(-1);
      const label = action && event.data.presentation?.[action.callId]?.label;
      const name = action && "toolName" in action ? action.toolName : "tools";
      return { ...state, startedAt, update: terseUpdate(label ?? `Running ${name}`) };
    }
    case "message.appended": {
      const messageKey = `${event.data.turnId}:${event.data.stepIndex}`;
      const messageText =
        (state.messageKey === messageKey ? (state.messageText ?? "") : "") +
        event.data.messageDelta;
      return {
        ...state,
        startedAt,
        messageKey,
        messageText: messageText.slice(0, 512),
        update: terseUpdate(messageText) || state.update,
      };
    }
    case "message.completed":
      return {
        ...state,
        startedAt,
        messageKey: undefined,
        messageText: undefined,
        update: terseUpdate(event.data.message ?? "") || state.update,
      };
    case "input.requested":
    case "authorization.required":
      return { ...state, startedAt, phase: "waiting", update: "Waiting for input" };
    case "input.resolved":
    case "authorization.completed":
      return { ...state, phase: "working", update: "Continuing…" };
    case "turn.completed":
    case "session.completed":
      return { ...state, startedAt, phase: "done", endedAt: state.endedAt ?? at };
    case "turn.failed":
    case "session.failed":
      return {
        ...state,
        startedAt,
        phase: "failed",
        endedAt: state.endedAt ?? at,
        update: terseUpdate(event.data.message),
      };
    case "turn.cancelled":
      return { ...state, startedAt, phase: "cancelled", endedAt: state.endedAt ?? at };
    default:
      return state;
  }
}
export function elapsedSeconds(progress: SubagentProgress, now: number) {
  return progress.startedAt === undefined
    ? 0
    : Math.max(0, Math.floor(((progress.endedAt ?? now) - progress.startedAt) / 1000));
}
