import type { ConversationState } from "#client/conversation-state.js";
import type { EveAgentStoreSnapshot } from "#client/eve-agent-store.js";
import type { EveAgentReducer } from "#client/reducer.js";
import {
  failureKey,
  formatFailureDetail,
  formatFailureHint,
  formatFailureMessage,
  type FailureStreamEvent,
} from "./errors.js";

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Terminal presentation facts that the canonical conversation does not model. */
export interface TuiSessionData {
  /** Step usage summed across the session; the renderer subtracts a turn baseline. */
  readonly usage: TokenUsage;
  /** The latest step's report, whose input restates the context size. */
  readonly lastStepUsage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  /** The model the latest turn resolved; cleared when another turn starts. */
  readonly modelId?: string;
  readonly modelTurnId?: string;
  /** One entry per failure cascade (`step.failed` → `turn.failed` → `session.failed`). */
  readonly failures: readonly FailureStreamEvent[];
  readonly sessionFailed: boolean;
  /** Failure keys seen since the last `turn.started`, for cascade deduplication. */
  readonly turnFailureKeys: readonly string[];
}

export const tuiSessionReducer: EveAgentReducer<TuiSessionData> = {
  initial: () => ({
    usage: { inputTokens: 0, outputTokens: 0 },
    failures: [],
    sessionFailed: false,
    turnFailureKeys: [],
  }),
  reduce(data, event) {
    switch (event.type) {
      case "turn.started": {
        const { turnId } = event.data;
        if (data.turnFailureKeys.length === 0 && turnId === data.modelTurnId) return data;
        const { modelId: _modelId, ...rest } = data;
        return turnId === data.modelTurnId
          ? { ...data, turnFailureKeys: [] }
          : { ...rest, modelTurnId: turnId, turnFailureKeys: [] };
      }
      case "step.started":
        return event.data.modelId === data.modelId
          ? data
          : { ...data, modelId: event.data.modelId, modelTurnId: event.data.turnId };
      case "step.completed": {
        const usage = event.data.usage;
        if (usage === undefined) return data;
        return {
          ...data,
          lastStepUsage: usage,
          usage: {
            inputTokens: data.usage.inputTokens + (usage.inputTokens ?? 0),
            outputTokens: data.usage.outputTokens + (usage.outputTokens ?? 0),
          },
        };
      }
      case "step.failed":
      case "turn.failed":
      case "session.failed": {
        const key = failureKey(event);
        const sessionFailed = data.sessionFailed || event.type === "session.failed";
        if (data.turnFailureKeys.includes(key)) return { ...data, sessionFailed };
        return {
          ...data,
          failures: [...data.failures, event],
          sessionFailed,
          turnFailureKeys: [...data.turnFailureKeys, key],
        };
      }
      default:
        return data;
    }
  },
};

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
  snapshot: EveAgentStoreSnapshot<TuiSessionData>,
  /** Replaces a failure's harness hint with a surface-local fix. */
  failureHint?: (event: FailureStreamEvent) => string | undefined,
): AgentTUIConversationView {
  return {
    conversation: snapshot.conversation,
    working: isWorking(snapshot.status),
    data: snapshot.data,
    failures: snapshot.data.failures.map((event) => {
      const failure: { message: string; hint?: string; detail?: string } = {
        message: formatFailureMessage(event),
      };
      const hint = failureHint?.(event) ?? formatFailureHint(event);
      if (hint !== undefined) failure.hint = hint;
      const detail = formatFailureDetail(event);
      if (detail !== undefined) failure.detail = detail;
      return failure;
    }),
  };
}

export function isWorking(status: EveAgentStoreSnapshot<unknown>["status"]): boolean {
  return status === "submitted" || status === "streaming" || status === "resuming";
}
