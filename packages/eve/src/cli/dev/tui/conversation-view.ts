import type { ConversationState } from "#client/conversation-state.js";
import { conversationTables } from "#client/conversation.js";
import { stripAnsi } from "#cli/ui/terminal-text.js";
import type { EveAgentStoreSnapshot } from "#client/eve-agent-store.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import type { SessionPreviews, SessionView } from "#protocol/session-projection/tables.js";
import { isTaskAdmissionRefused } from "#protocol/task-tools.js";
import { failureKey, formatFailureDetail, formatFailureMessage } from "./errors.js";

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** What the terminal shows beyond the conversation's messages, read from the same tables. */
export interface TuiSessionData {
  /** Usage summed across the session; the renderer subtracts a turn baseline. */
  readonly usage: TokenUsage;
  /** The latest step's usage, whose input restates the context size. */
  readonly lastStepUsage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  /** The model the latest turn ran. */
  readonly modelId?: string;
  /** Each distinct turn or session failure, in order. */
  readonly failures: readonly ErrorInfo[];
  readonly sessionFailed: boolean;
  /** The tool's authored copy for a call, which the conversation's one `label` doesn't separate. */
  readonly toolLabels: (callId: string) => ToolLabels | undefined;
  /** Calls the session refused for the model to retry; people only see the retry. */
  readonly withdrawn: (callId: string) => boolean;
}

export interface ToolLabels {
  readonly start?: string;
  readonly complete?: string;
}

export function tuiSessionData(conversation: ConversationState): TuiSessionData {
  const { previews, view } = conversationTables(conversation);
  const turnRuns = Object.values(view.runs).filter((run) => "turnId" in run.owner);
  const latestTurnId = view.session.latestTurnId;
  const modelId = turnRuns
    .findLast((run) => run.modelId !== undefined && runTurnId(run) === latestTurnId)
    ?.modelId?.slice(0, 256);
  const { total } = view.usage;
  return {
    failures: failuresOf(view),
    lastStepUsage: turnRuns.findLast((run) => run.usage !== undefined)?.usage,
    // The model id is printed in the status line, so it must not carry terminal controls.
    modelId: modelId && (stripAnsi(modelId).replace(/\s+/gu, " ").trim() || undefined),
    sessionFailed: view.session.outcome === "failed",
    toolLabels: (callId) => toolLabels(view, previews, callId),
    usage: { inputTokens: total.inputTokens, outputTokens: total.outputTokens },
    withdrawn: (callId) => {
      const row = view.calls[callId];
      return row !== undefined && isTaskAdmissionRefused(row);
    },
  };
}

function runTurnId(run: SessionView["runs"][string]): string | undefined {
  return "turnId" in run.owner ? run.owner.turnId : undefined;
}

/** Each failed turn's failure, then the session's unless it repeats the turn that failed it. */
function failuresOf(view: SessionView): readonly ErrorInfo[] {
  const failures = Object.values(view.turns).flatMap((turn) => turnFailure(turn) ?? []);
  const { cause, error, latestTurnId, outcome } = view.session;
  if (outcome !== "failed") return failures;
  const failure = error ?? { code: "SESSION_FAILED", message: "The session failed." };
  const turnId = cause !== undefined && "turnId" in cause ? cause.turnId : latestTurnId;
  const repeats = turnFailure(turnId === undefined ? undefined : view.turns[turnId]);
  return repeats !== undefined && failureKey(repeats) === failureKey(failure)
    ? failures
    : [...failures, failure];
}

function turnFailure(turn: SessionView["turns"][string] | undefined): ErrorInfo | undefined {
  if (turn?.outcome !== "failed") return undefined;
  return turn.error ?? { code: "TURN_FAILED", message: "The turn failed." };
}

function toolLabels(
  view: SessionView,
  previews: SessionPreviews,
  callId: string,
): ToolLabels | undefined {
  const row = view.calls[callId];
  const start = previews.calls[callId]?.label ?? row?.capability.label;
  const complete = row?.label;
  if (start === undefined && complete === undefined) return undefined;
  return { ...(start !== undefined && { start }), ...(complete !== undefined && { complete }) };
}

/** One rendered failure cascade. */
export interface AgentTUIFailure {
  readonly message: string;
  readonly hint?: string;
  /** Diagnostic dump for unrecognized failures. */
  readonly detail?: string;
}

/** Everything the renderer draws for the session, derived from one store snapshot. */
export interface AgentTUIConversationView {
  readonly conversation: ConversationState;
  /** A turn is being submitted or is running, including server-initiated turns. */
  readonly working: boolean;
  readonly data: TuiSessionData;
  readonly failures: readonly AgentTUIFailure[];
}

export function conversationView(
  snapshot: EveAgentStoreSnapshot,
  data: TuiSessionData,
  /** Replaces a failure's harness hint with a surface-local fix. */
  failureHint?: (error: ErrorInfo) => string | undefined,
): AgentTUIConversationView {
  return {
    conversation: snapshot.data,
    working: isWorking(snapshot.status),
    data,
    failures: data.failures.map((error) => {
      const failure: { message: string; hint?: string; detail?: string } = {
        message: formatFailureMessage(error),
      };
      const hint = failureHint?.(error) ?? error.hint;
      if (hint !== undefined) failure.hint = hint;
      const detail = formatFailureDetail(error);
      if (detail !== undefined) failure.detail = detail;
      return failure;
    }),
  };
}

export function isWorking(status: EveAgentStoreSnapshot["status"]): boolean {
  return status === "submitted" || status === "streaming" || status === "resuming";
}
