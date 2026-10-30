import { snapshotState } from "#protocol/session-projection/session-view.js";
import type { ConversationState } from "#client/conversation-state.js";
import { stripAnsi } from "#cli/ui/terminal-text.js";
import type { SessionStoreSnapshot } from "#client/session-store.js";
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
  readonly view: SessionView;
  /** Usage summed across the session; the renderer subtracts a turn baseline. */
  readonly usage: TokenUsage;
  /** The latest step's usage, whose input restates the context size. */
  readonly lastStepUsage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  /** The model the latest turn ran. */
  readonly modelId?: string;
  /** Each distinct turn or session failure, in order, with the turn it ended. */
  readonly failures: readonly TuiFailure[];
  readonly sessionFailed: boolean;
  /** The tool's authored copy for a call, which the conversation's one `label` doesn't separate. */
  readonly toolLabels: (callId: string) => ToolLabels | undefined;
  /** Calls the session refused for the model to retry; people only see the retry. */
  readonly withdrawn: (callId: string) => boolean;
}

/** A failure, and the turn it ended when it ended one. */
export interface TuiFailure {
  readonly error: ErrorInfo;
  readonly turnId?: string;
}

export interface ToolLabels {
  readonly start?: string;
  readonly complete?: string;
}

export function tuiSessionData(conversation: ConversationState): TuiSessionData {
  const { previews, tables: view } = snapshotState(conversation.view);
  const turnRuns = Object.values(view.runs).filter((run) => "turnId" in run.owner);
  const latestTurnId = view.session.latestTurnId;
  const modelId = turnRuns
    .findLast((run) => run.modelId !== undefined && runTurnId(run) === latestTurnId)
    ?.modelId?.slice(0, 256);
  const { total } = view.usage;
  return {
    view,
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

/**
 * Each failed turn's failure, then the session's. A failed session cancels the turn it ended, so
 * its failure is that turn's, unless the turn failed itself: then it is dropped when it repeats
 * the turn's, and otherwise belongs to no turn.
 */
function failuresOf(view: SessionView): readonly TuiFailure[] {
  const failures = Object.values(view.turns).flatMap((turn): TuiFailure[] => {
    const error = turnFailure(turn);
    return error === undefined ? [] : [{ error, turnId: turn.turnId }];
  });
  const { cause, error, latestTurnId, outcome } = view.session;
  if (outcome !== "failed") return failures;
  const failure = error ?? { code: "SESSION_FAILED", message: "The session failed." };
  const causeTurnId = cause !== undefined && "turnId" in cause ? cause.turnId : undefined;
  const turnId = causeTurnId ?? latestTurnId;
  const own = turnFailure(turnId === undefined ? undefined : view.turns[turnId]);
  if (own === undefined)
    return [
      ...failures,
      { error: failure, ...(causeTurnId !== undefined && { turnId: causeTurnId }) },
    ];
  return failureKey(own) === failureKey(failure) ? failures : [...failures, { error: failure }];
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
  /** The turn the failure ended; a failure of none renders after the conversation. */
  readonly turnId?: string;
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
  snapshot: SessionStoreSnapshot,
  data: TuiSessionData,
  /** Replaces a failure's harness hint with a surface-local fix. */
  failureHint?: (error: ErrorInfo) => string | undefined,
): AgentTUIConversationView {
  return {
    conversation: snapshot,
    working: isWorking(snapshot.status),
    data,
    failures: data.failures.map(({ error, turnId }) => {
      const failure: { message: string; hint?: string; detail?: string; turnId?: string } = {
        message: formatFailureMessage(error),
        ...(turnId !== undefined && { turnId }),
      };
      const hint = failureHint?.(error) ?? error.hint;
      if (hint !== undefined) failure.hint = hint;
      const detail = formatFailureDetail(error);
      if (detail !== undefined) failure.detail = detail;
      return failure;
    }),
  };
}

export function isWorking(status: SessionStoreSnapshot["status"]): boolean {
  return status === "busy" || status === "resuming";
}
