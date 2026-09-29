import { initialConversationState, reduceConversation } from "#client/conversation-reducer.js";
import type { ConversationState } from "#client/conversation-state.js";
import type { MessageStreamEvent } from "#protocol/message.js";

export type Source = {
  readonly key: string;
  readonly sessionId: string;
  readonly parentKey?: string;
  readonly callId?: string;
  readonly taskId?: string;
  readonly streamPath?: string;
  readonly remote?: { readonly name: string; readonly url: string; readonly resolverId?: string };
  readonly nextIndex: number;
  readonly conversation: ConversationState;
  readonly completedReplies: Readonly<
    Record<string, { readonly turnId: string; readonly text: string }>
  >;
  readonly pendingToolCall?: {
    readonly turnId: string;
    readonly stepIndex: number;
    readonly partId?: string;
    readonly text: string;
    readonly actionNames: readonly string[];
  };
  readonly unsupportedInteraction?: boolean;
  readonly unsupported?: boolean;
  readonly unavailable?: boolean;
};

export interface ObservationState {
  readonly version: 1;
  readonly rootKey: string;
  readonly revision: number;
  readonly sources: Readonly<Record<string, Source>>;
  readonly sourceOrder: readonly string[];
  readonly terminal?: boolean;
  readonly terminalFailure?: boolean;
}

export interface IndexedRecord {
  readonly index: number;
  readonly event: MessageStreamEvent;
}

export function initialObservation(sessionId: string): ObservationState {
  return {
    version: 1,
    rootKey: sessionId,
    revision: 0,
    sources: {
      [sessionId]: {
        key: sessionId,
        sessionId,
        nextIndex: 0,
        conversation: initialConversationState(),
        completedReplies: {},
      },
    },
    sourceOrder: [sessionId],
  };
}

/** Source positions and the projection consuming them advance in the same returned checkpoint. */
export function applyObservationPage(
  state: ObservationState,
  sourceKey: string,
  records: readonly IndexedRecord[],
): ObservationState {
  const source = state.sources[sourceKey];
  if (source === undefined) throw new Error(`Unknown observation source: ${sourceKey}`);
  let cursor = source.nextIndex;
  let conversation = source.conversation;
  let replies = source.completedReplies;
  let pendingToolCall = source.pendingToolCall;
  let changed = false;
  let unsupportedInteraction = source.unsupportedInteraction ?? false;
  let terminal = state.terminal ?? false;
  let terminalFailure = state.terminalFailure ?? false;
  const discovered: Source[] = [];

  for (const record of records) {
    if (record.index < cursor) continue;
    if (record.index !== cursor) {
      throw new Error(`Observation source ${sourceKey} has a gap at ${cursor}`);
    }
    cursor++;
    if (record.event.type === "turn.started") pendingToolCall = undefined;
    if (sourceKey === state.rootKey) {
      if (record.event.type === "session.completed" || record.event.type === "session.failed")
        terminal = true;
      if (record.event.type === "session.failed") terminalFailure = true;
    }
    if (
      ["input.requested", "approval.candidate", "authorization.required"].includes(
        record.event.type,
      )
    )
      unsupportedInteraction = true;
    const reduced = reduceConversation(conversation, record.event);
    if (reduced !== conversation) changed = true;
    conversation = reduced;
    if (record.event.type === "message.completed") {
      const { finishReason, message: text, stepIndex, turnId } = record.event.data;
      if (finishReason !== "tool-calls") pendingToolCall = undefined;
      if (finishReason === "tool-calls" && text.trim()) {
        const part = conversation.messages
          .find((message) => message.role === "assistant" && message.metadata?.turnId === turnId)
          ?.parts.findLast((item) => item.type === "text" && item.stepIndex === stepIndex);
        const previous =
          pendingToolCall?.turnId === turnId && pendingToolCall.stepIndex === stepIndex
            ? pendingToolCall
            : undefined;
        pendingToolCall = {
          turnId,
          stepIndex,
          partId: part?.type === "text" ? part.id : undefined,
          text: previous?.text ? `${previous.text}\n${text}` : text,
          actionNames: previous?.actionNames ?? [],
        };
      }
      if (finishReason !== "tool-calls" && text.trim()) {
        const part = conversation.messages
          .find((message) => message.role === "assistant" && message.metadata?.turnId === turnId)
          ?.parts.findLast((item) => item.type === "text" && item.stepIndex === stepIndex);
        if (part?.type === "text" && part.id !== undefined) {
          replies = { ...replies, [part.id]: { turnId, text } };
          changed = true;
        }
      }
    }
    if (record.event.type === "actions.requested" && pendingToolCall !== undefined) {
      const { stepIndex, turnId, actions } = record.event.data;
      if (pendingToolCall.turnId === turnId && pendingToolCall.stepIndex === stepIndex) {
        pendingToolCall = {
          ...pendingToolCall,
          actionNames: [
            ...pendingToolCall.actionNames,
            ...actions.map((action) =>
              action.kind === "tool-call" ? action.toolName : action.kind,
            ),
          ],
        };
      }
    }
    if (record.event.type === "step.completed" && pendingToolCall !== undefined) {
      if (
        pendingToolCall.turnId === record.event.data.turnId &&
        pendingToolCall.stepIndex === record.event.data.stepIndex
      ) {
        if (
          pendingToolCall.actionNames.length === 1 &&
          pendingToolCall.actionNames[0] === "task_wait" &&
          pendingToolCall.partId !== undefined
        ) {
          replies = {
            ...replies,
            [pendingToolCall.partId]: {
              turnId: pendingToolCall.turnId,
              text: pendingToolCall.text,
            },
          };
          changed = true;
        }
        pendingToolCall = undefined;
      }
    }
    if (record.event.type === "agent.started") {
      const { sessionId, callId, taskId, name, remote, streamPath } = record.event.data;
      const key = `${sourceKey}/${callId}/${sessionId}`;
      if (state.sources[key] === undefined && !discovered.some((child) => child.key === key)) {
        const child: { -readonly [K in keyof Source]: Source[K] } = {
          key,
          sessionId,
          parentKey: sourceKey,
          callId,
          taskId,
          streamPath,
          nextIndex: 0,
          conversation: initialConversationState(),
          completedReplies: {},
        };
        if (sourceKey !== state.rootKey) child.unsupported = true;
        if (remote !== undefined) child.remote = { name, ...remote };
        discovered.push(child);
        changed = true;
      }
    }
  }
  if (cursor === source.nextIndex) return state;
  const sources: Record<string, Source> = {
    ...state.sources,
    [sourceKey]: {
      ...source,
      nextIndex: cursor,
      conversation,
      completedReplies: replies,
      pendingToolCall,
    },
  };
  const updated = sources[sourceKey] as { -readonly [K in keyof Source]: Source[K] };
  if (unsupportedInteraction) updated.unsupportedInteraction = true;
  if (source.unavailable) updated.unavailable = false;
  for (const child of discovered) sources[child.key] = child;
  if (source.parentKey !== undefined) {
    const parent = sources[source.parentKey];
    if (parent !== undefined && parent.conversation.agents[source.sessionId] !== undefined) {
      const following = reduceConversation(parent.conversation, {
        type: "client.agent.following",
        data: { sessionId: source.sessionId },
      });
      let observed = following;
      for (const record of records) {
        if (record.index < source.nextIndex || record.index >= cursor) continue;
        observed = reduceConversation(observed, {
          type: "client.agent.observed",
          data: { sessionId: source.sessionId, event: record.event },
        });
      }
      if (observed !== parent.conversation) {
        sources[source.parentKey] = { ...parent, conversation: observed };
        changed = true;
      }
    }
  }
  return {
    ...state,
    terminal,
    terminalFailure,
    revision:
      state.revision +
      (changed ||
      terminal !== (state.terminal ?? false) ||
      terminalFailure !== (state.terminalFailure ?? false) ||
      source.unavailable === true ||
      unsupportedInteraction !== (source.unsupportedInteraction ?? false)
        ? 1
        : 0),
    sourceOrder: [...state.sourceOrder, ...discovered.map((child) => child.key)],
    sources,
  };
}
