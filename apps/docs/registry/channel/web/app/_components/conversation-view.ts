import {
  type ConversationAgentSession,
  type ConversationInput,
  type ConversationState,
  type ConversationTask,
  type ConversationTaskCall,
  type EveAuthorizationPart,
  type EveMessage,
  type EveMessagePart,
  type ToolCallState,
  type ToolCallStatus,
  signInState,
  toolCallState,
} from "eve/react";

// Turns a conversation into what the chat renders. Styling lives in the components; this file
// only decides what each row is and what state it's in.

export interface ViewContext {
  readonly conversation: ConversationState;
  /** Whether the session's stream is still delivering, which a running call waits on. */
  readonly busy: boolean;
  /** Calls that started a subagent, by call ID. */
  readonly agentCalls: ReadonlyMap<string, AgentCall>;
}

export interface AgentCall {
  readonly task: ConversationTask;
  readonly call: ConversationTaskCall;
  readonly agent: ConversationAgentSession;
}

export function viewContext(conversation: ConversationState, busy: boolean): ViewContext {
  const agentCalls = new Map<string, AgentCall>();
  for (const task of Object.values(conversation.tasks)) {
    const agent = agentToolSession(conversation, task);
    if (agent === undefined) continue;
    for (const call of Object.values(task.calls))
      agentCalls.set(call.callId, { agent, call, task });
  }
  return { agentCalls, busy, conversation };
}

// ---------------------------------------------------------------------------
// Message blocks: prose, and the work between it
// ---------------------------------------------------------------------------

export type ActivityItem =
  | { readonly kind: "reasoning"; readonly key: string; readonly text: string }
  | { readonly kind: "text"; readonly key: string; readonly text: string }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly name: string;
      readonly input: unknown;
      readonly state: ToolCallState;
      /** Set when the call started a subagent, whose work nests under the row. */
      readonly agent?: AgentCall;
    }
  | {
      readonly kind: "auth";
      readonly key: string;
      readonly part: EveAuthorizationPart;
      readonly state: ToolCallState;
    };

/** Something that waits on the person, shown outside the folded activity until it's done. */
export type PendingRequest =
  | {
      readonly kind: "input";
      readonly key: string;
      readonly input: ConversationInput;
      /** The subagent or task that passed the request up, when this session didn't ask. */
      readonly from?: string;
    }
  | { readonly kind: "auth"; readonly key: string; readonly part: EveAuthorizationPart };

export type MessageBlock =
  | { readonly kind: "text"; readonly key: string; readonly text: string; streaming: boolean }
  | { readonly kind: "activity"; readonly key: string; readonly items: ActivityItem[] }
  | { readonly kind: "requests"; readonly key: string; readonly requests: PendingRequest[] };

/**
 * Splits an assistant message into its prose, one activity block for each run of work, and one
 * block for each run of requests that wait on the person.
 */
export function messageBlocks(message: EveMessage, context: ViewContext): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  for (const [index, part] of message.parts.entries()) {
    if (part.type === "text") {
      if (part.text.trim().length === 0) continue;
      const key = `text:${part.id ?? index}`;
      blocks.push({ key, kind: "text", streaming: part.state === "streaming", text: part.text });
      continue;
    }
    const last = blocks.at(-1);
    const request = pendingRequest(part, context.conversation);
    if (request !== undefined) {
      if (last?.kind === "requests") last.requests.push(request);
      else blocks.push({ key: `requests:${request.key}`, kind: "requests", requests: [request] });
      continue;
    }
    const item = activityItem(part, index, context);
    if (item === undefined) continue;
    if (last?.kind === "activity") last.items.push(item);
    else blocks.push({ items: [item], key: `activity:${item.key}`, kind: "activity" });
  }
  return blocks;
}

function pendingRequest(
  part: EveMessagePart,
  conversation: ConversationState,
): PendingRequest | undefined {
  if (part.type === "authorization") {
    if (signInState(conversation, part).status !== "required") return undefined;
    return { key: `auth:${part.attemptId}`, kind: "auth", part };
  }
  if (part.type !== "dynamic-tool") return undefined;
  const requestId = part.toolMetadata?.eve?.inputRequest?.requestId;
  const input = requestId === undefined ? undefined : conversation.inputs[requestId];
  if (input === undefined || !isPending(input)) return undefined;
  return { from: askedBy(conversation, input), input, key: `input:${requestId}`, kind: "input" };
}

/**
 * An approval stays with its batch until the batch names the turn that runs it; any other
 * request is done once it settles.
 */
function isPending(input: ConversationInput): boolean {
  if (input.status !== "settled") return true;
  return (
    input.request.kind === "tool-approval" &&
    input.outcome === "approved" &&
    input.callId === input.request.action.callId &&
    input.resumeTurnId === undefined
  );
}

/** The subagent or task whose call a passed-up request waits on, when this session didn't ask. */
function askedBy(conversation: ConversationState, input: ConversationInput): string | undefined {
  const { callId } = input;
  if (callId === undefined || callId === input.request.action.callId) return undefined;
  const task = Object.values(conversation.tasks).find((entry) => entry.calls[callId] !== undefined);
  return task === undefined ? undefined : (agentToolSession(conversation, task)?.name ?? task.name);
}

/** A subagent's call this session shows only because its task passed up an approval for it. */
function isPassedUp(conversation: ConversationState, requestId: string | undefined): boolean {
  const input = requestId === undefined ? undefined : conversation.inputs[requestId];
  return input?.callId !== undefined && input.callId !== input.request.action.callId;
}

/** A subagent's work for one call, prose included, with the same rules as the root. */
export function agentActivity(call: AgentCall): ActivityItem[] | undefined {
  const observation = call.agent.observation;
  const child = observation?.status === "not-followed" ? undefined : observation?.conversation;
  if (child === undefined) return undefined;
  const turnIds = new Set(agentCallTurns(call.task, child).get(call.call.callId) ?? []);
  const context = viewContext(child, call.call.status === "working");
  return child.messages.flatMap((message) => {
    const turnId = message.metadata?.turnId;
    if (message.role !== "assistant" || turnId === undefined || !turnIds.has(turnId)) return [];
    return message.parts.flatMap((part, index) => {
      if (part.type !== "text") return activityItem(part, index, context) ?? [];
      const text = part.text.trim();
      return text.length === 0 ? [] : [{ key: `text:${part.id ?? index}`, kind: "text", text }];
    });
  });
}

function activityItem(
  part: EveMessagePart,
  index: number,
  context: ViewContext,
): ActivityItem | undefined {
  switch (part.type) {
    case "reasoning": {
      const text = part.text.trim();
      return text.length === 0
        ? undefined
        : { key: `reasoning:${part.id ?? index}`, kind: "reasoning", text };
    }
    case "authorization":
      return {
        key: `auth:${part.attemptId}`,
        kind: "auth",
        part,
        state: authorizationState(context.conversation, part),
      };
    case "dynamic-tool": {
      const callId = part.toolCallId;
      const request = part.toolMetadata?.eve?.inputRequest;
      if (request?.kind === "session-limit") return undefined;
      // A subagent's call shows in its own session; here its passed-up request shows where it arrived.
      if (isPassedUp(context.conversation, request?.requestId)) return undefined;
      return {
        agent: context.agentCalls.get(callId),
        input: part.input,
        key: `tool:${callId}`,
        kind: "tool",
        name: part.toolMetadata?.eve?.name ?? part.toolName,
        state: toolCallState(context.conversation, part, { streaming: context.busy }),
      };
    }
    default:
      return undefined;
  }
}

function authorizationState(
  conversation: ConversationState,
  part: EveAuthorizationPart,
): ToolCallState {
  const signIn = signInState(conversation, part);
  if (signIn.status === "required") return { status: "awaiting-input" };
  const reason = part.state === "completed" ? part.reason : undefined;
  switch (signIn.outcome) {
    case "authorized":
      return { status: "completed" };
    case "declined":
      return { errorText: reason, status: "rejected" };
    default:
      return { errorText: reason ?? signIn.outcome, status: "failed" };
  }
}

export function itemStatus(item: ActivityItem): ToolCallStatus {
  return item.kind === "tool" || item.kind === "auth" ? item.state.status : "completed";
}

/** The chosen option's label, or the typed text, once a request has an answer. */
export function inputAnswer(input: ConversationInput): string | undefined {
  const response = input.response;
  if (response === undefined) return input.outcome;
  const option = input.request.options?.find((candidate) => candidate.id === response.optionId);
  return option?.label ?? response.text ?? response.optionId;
}

// ---------------------------------------------------------------------------
// Subagent sessions
// ---------------------------------------------------------------------------

/** The session an agent tool's task sends its calls to. */
function agentToolSession(
  conversation: ConversationState,
  task: ConversationTask,
): ConversationAgentSession | undefined {
  if (task.kind !== "agent") return undefined;
  return Object.values(conversation.agents).find((agent) => agent.taskId === task.taskId);
}

/**
 * Each call to an agent tool sends its session one message, in call order, so a call's turns run
 * from its message's turn up to the next call's.
 */
function agentCallTurns(
  task: ConversationTask,
  child: ConversationState,
): ReadonlyMap<string, readonly string[]> {
  const callIds = Object.keys(task.calls);
  const owners = new Map<string, string>();
  let index = 0;
  for (const message of child.messages) {
    if (message.role !== "user") continue;
    const callId = callIds[index++];
    const turnId = message.metadata?.turnId;
    if (callId !== undefined && turnId !== undefined && !owners.has(turnId)) {
      owners.set(turnId, callId);
    }
  }
  const turns = new Map<string, string[]>(callIds.map((callId) => [callId, []]));
  let owner: string | undefined;
  for (const turnId of Object.keys(child.turns)) {
    owner = owners.get(turnId) ?? owner;
    if (owner !== undefined) turns.get(owner)?.push(turnId);
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** A short, single-line description of a call's input. */
export function describeInput(input: unknown): string | undefined {
  if (typeof input === "string") return oneLine(input);
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${oneLine(String(value))}`);
    }
    if (parts.length === 3) break;
  }
  return parts.length === 0 ? undefined : parts.join(", ");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
