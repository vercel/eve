import type { ModelMessage, UserContent } from "ai";

import type { MessageContent, MessagePart } from "#shared/message-content.js";

import type {
  ChannelDeliveryMetadataEntry,
  DeliverPayload,
  SessionAuthContext,
  TurnCaller,
} from "#channel/types.js";
import type { Answer } from "#shared/input.js";
import type { HarnessStepInput } from "#harness/types.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";
import { attachInputText, readInputText } from "#internal/input-text.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";

export type FrameworkMessageKind =
  | "context.instruction"
  | "context.state"
  | "context.compaction"
  | "memory.load"
  | "execution.continuation"
  | "execution.retry"
  | "task.result";

export type UserMessageKind = "user" | FrameworkMessageKind;

export type UserModelMessage = Extract<ModelMessage, { readonly role: "user" }> & {
  readonly kind: UserMessageKind;
  readonly metadata?: Record<string, unknown>;
};

export type HarnessModelMessage =
  | Exclude<ModelMessage, { readonly role: "user" }>
  | UserModelMessage;

type FrameworkUserMessage = UserModelMessage & {
  readonly kind: FrameworkMessageKind;
};

export function createUserMessage(
  kind: FrameworkMessageKind,
  content: UserContent,
  metadata?: Record<string, unknown>,
): FrameworkUserMessage;
export function createUserMessage(
  kind: "user",
  content: UserContent,
  metadata?: Record<string, unknown>,
): UserModelMessage;
export function createUserMessage(
  kind: UserMessageKind,
  content: UserContent,
  metadata?: Record<string, unknown>,
): UserModelMessage {
  const message: UserModelMessage = { content, kind, role: "user" };
  return metadata === undefined ? message : { ...message, metadata };
}

export const IMPORTED_MESSAGE_METADATA_KEY = "eve.imported";

export function createImportedHistoryMessages(
  history: readonly SessionHistoryMessage[],
): HarnessModelMessage[] {
  return history.map((message) =>
    message.role === "user"
      ? createUserMessage("user", message.text, { [IMPORTED_MESSAGE_METADATA_KEY]: true })
      : { content: message.text, role: "assistant" },
  );
}

export function createFrameworkUserMessage(
  kind: FrameworkMessageKind,
  content: UserContent,
  metadata?: Record<string, unknown>,
): FrameworkUserMessage {
  return createUserMessage(kind, content, metadata);
}

const TURN_ANCHOR_KEY = "eve.turn";

export function anchorToTurn<T extends UserModelMessage>(message: T, turnId: string): T {
  return { ...message, metadata: { ...message.metadata, [TURN_ANCHOR_KEY]: turnId } };
}

export function turnAnchorOf(message: HarnessModelMessage): string | undefined {
  if (message.role !== "user") return undefined;
  const turnId = message.metadata?.[TURN_ANCHOR_KEY];
  return typeof turnId === "string" ? turnId : undefined;
}

export function isUserMessageKind(value: unknown): value is UserMessageKind {
  return value === "user" || isFrameworkMessageKind(value);
}

export function isUserModelMessage(message: ModelMessage): message is UserModelMessage {
  if (message.role !== "user") return false;
  const { kind } = message as ModelMessage & { readonly kind?: unknown };
  return isUserMessageKind(kind);
}

export function isFrameworkUserMessage(message: ModelMessage): message is FrameworkUserMessage {
  return isUserModelMessage(message) && message.kind !== "user";
}

export function validateHarnessModelMessages(
  messages: readonly ModelMessage[],
): HarnessModelMessage[] {
  const validated: HarnessModelMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user") {
      validated.push(message);
      continue;
    }
    if (!isUserModelMessage(message)) {
      throw new TypeError("Expected every user-role model message to have a kind.");
    }
    validated.push(message);
  }
  return validated;
}

export function isFrameworkMessageKind(value: unknown): value is FrameworkMessageKind {
  return (
    value === "context.instruction" ||
    value === "context.state" ||
    value === "context.compaction" ||
    value === "memory.load" ||
    value === "execution.continuation" ||
    value === "execution.retry" ||
    value === "task.result"
  );
}

type FrameworkStepInput = HarnessStepInput & {
  readonly frameworkMessageKind?: FrameworkMessageKind;
};

export function markFrameworkStepInput<T extends object>(input: T, kind: FrameworkMessageKind): T {
  return { ...input, frameworkMessageKind: kind };
}

export function frameworkMessageKindForStepInput(
  input: object | undefined,
): FrameworkMessageKind | undefined {
  if (input === undefined) return undefined;
  const { frameworkMessageKind } = input as FrameworkStepInput;
  return isFrameworkMessageKind(frameworkMessageKind) ? frameworkMessageKind : undefined;
}

type TurnInput = Omit<HarnessStepInput, "answers"> & { readonly answers?: readonly Answer[] };

export function coalesceTurnInputs<T extends TurnInput>(a: T, b: T): T {
  const answers = coalesceAnswers({
    a: a.answers,
    b: b.answers,
  });
  const message = coalesceMessage({
    a: a.message,
    b: b.message,
  });
  const context = coalesceContext({
    a: a.context,
    b: b.context,
  });
  const history = [...(a.history ?? []), ...(b.history ?? [])];
  const frameworkMessageKind = coalesceFrameworkMessageKind({ a, b });
  const ephemeralContext = coalesceContext({
    a: readClientContext(a),
    b: readClientContext(b),
  });
  const outputSchema = b.outputSchema ?? a.outputSchema;

  const result: {
    history?: HarnessStepInput["history"];
    deliveries?: HarnessStepInput["deliveries"];
    answers?: readonly Answer[];
    message?: MessageContent;
    context?: readonly string[];
    outputSchema?: HarnessStepInput["outputSchema"];
  } = {};
  const deliveries = [...(a.deliveries ?? []), ...(b.deliveries ?? [])];
  if (deliveries.length > 0) result.deliveries = deliveries;
  if (answers !== undefined) {
    result.answers = answers;
  }

  if (message !== undefined) {
    result.message = message;
  }

  if (context !== undefined) {
    result.context = context;
  }

  if (history.length > 0) {
    result.history = history;
  }

  if (outputSchema !== undefined) {
    result.outputSchema = outputSchema;
  }

  const inputText =
    normalizeMessage(a.message) === undefined
      ? readInputText(b)
      : normalizeMessage(b.message) === undefined
        ? readInputText(a)
        : undefined;
  return attachClientContext(
    attachInputText(
      frameworkMessageKind === undefined
        ? result
        : markFrameworkStepInput(result, frameworkMessageKind),
      inputText,
    ) as T,
    ephemeralContext,
  );
}

export function normalizeMessage(content: MessageContent | undefined): MessageContent | undefined {
  if (content === undefined) {
    return undefined;
  }

  if (typeof content === "string") {
    return content.trim().length > 0 ? content : undefined;
  }

  const parts = content.filter((part) => part.type !== "text" || part.text.trim().length > 0);
  if (parts.length === 0) {
    return undefined;
  }
  return parts.length === content.length ? content : parts;
}

export const TOOL_RESULT_BOUNDARY = "…";

export function followsToolResults(messages: readonly ModelMessage[]): boolean {
  return messages.findLast((message) => message.role !== "user")?.role === "tool";
}

export function normalizeModelMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.flatMap((message) => {
    if (typeof message.content === "string") {
      return message.content.trim().length > 0 ? [message] : [];
    }

    const content = message.content.filter(
      (part) => part.type !== "text" || part.text.trim().length > 0,
    );
    if (content.length === 0) return [];
    return content.length === message.content.length
      ? [message]
      : [{ ...message, content } as ModelMessage];
  });
}

export function resolveAssistantStepText(
  messages: readonly ModelMessage[],
  fallback: string | undefined,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }

    const text = extractMessageText(message);
    if (text.trim().length > 0) {
      return text;
    }
  }

  if (fallback !== undefined && fallback.trim().length > 0) {
    return fallback;
  }

  return null;
}

function extractMessageText(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .flatMap((part) => {
      if (typeof part === "string") {
        return [part];
      }

      return "type" in part && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [];
    })
    .join("");
}

function coalesceAnswers(input: {
  readonly a?: readonly Answer[];
  readonly b?: readonly Answer[];
}): readonly Answer[] | undefined {
  const a = input.a ?? [];
  const b = input.b ?? [];

  if (a.length === 0 && b.length === 0) {
    return undefined;
  }

  return [...a, ...b];
}

function coalesceContext(input: {
  readonly a?: readonly string[];
  readonly b?: readonly string[];
}): readonly string[] | undefined {
  const a = input.a ?? [];
  const b = input.b ?? [];

  if (a.length === 0 && b.length === 0) {
    return undefined;
  }

  return [...a, ...b];
}

function coalesceFrameworkMessageKind(input: {
  readonly a: TurnInput;
  readonly b: TurnInput;
}): FrameworkMessageKind | undefined {
  const a = frameworkMessageKindForStepInput(input.a);
  const b = frameworkMessageKindForStepInput(input.b);
  if (input.a.message === undefined) return b;
  if (input.b.message === undefined) return a;
  return a === b ? a : undefined;
}

function coalesceMessage(input: {
  readonly a?: MessageContent;
  readonly b?: MessageContent;
}): MessageContent | undefined {
  const a = normalizeMessage(input.a);
  const b = normalizeMessage(input.b);

  if (a === undefined) {
    return b;
  }

  if (b === undefined) {
    return a;
  }

  return appendMessage({ appended: b, existing: a });
}

export function appendMessage(input: {
  readonly appended: MessageContent;
  readonly existing: MessageContent;
}): MessageContent {
  if (typeof input.existing === "string" && typeof input.appended === "string") {
    return `${input.existing}\n\n${input.appended}`;
  }
  return [...partsOf(input.existing), ...partsOf(input.appended)];
}

function partsOf(value: MessageContent): readonly MessagePart[] {
  if (typeof value !== "string") return value;
  return value.length > 0 ? [{ text: value, type: "text" }] : [];
}

export function userContentOf(message: MessageContent): string | UserContent {
  return typeof message === "string" ? message : [...message];
}

interface DeliverLike {
  readonly auth?: SessionAuthContext | null;
  readonly caller?: TurnCaller;
  readonly deliveryMetadata?: readonly ChannelDeliveryMetadataEntry[];
  readonly kind: "deliver";
  readonly payloads: readonly DeliverPayload[];
  readonly steeredBy?: readonly SessionAuthContext[];
}

export function coalesceDeliveries<T extends DeliverLike>(items: readonly T[]): T {
  const [first, ...rest] = items;

  if (first === undefined) {
    throw new Error("Cannot coalesce an empty delivery batch.");
  }

  let auth = first.auth;
  let caller = first.caller;
  let steeredBy = first.steeredBy;
  const payloads = [...first.payloads];
  const deliveryMetadata = [...(first.deliveryMetadata ?? [])];

  for (const item of rest) {
    const payloadOffset = payloads.length;
    if (item.auth !== undefined) {
      auth = item.auth;
    }
    if (item.caller !== undefined) {
      if (caller !== undefined && caller.callId !== item.caller.callId) {
        throw new Error("Cannot coalesce deliveries from different turns.");
      }
      caller = item.caller;
    }
    steeredBy = item.steeredBy;
    payloads.push(...item.payloads);
    deliveryMetadata.push(
      ...(item.deliveryMetadata ?? []).map((entry) => ({
        ...entry,
        payloadIndex: entry.payloadIndex + payloadOffset,
      })),
    );
  }

  const merged: T = {
    ...first,
    auth,
    caller,
    deliveryMetadata: deliveryMetadata.length === 0 ? undefined : deliveryMetadata,
    payloads,
  };
  const writable = merged as { -readonly [K in keyof DeliverLike]: DeliverLike[K] };
  if (steeredBy === undefined) delete writable.steeredBy;
  else writable.steeredBy = steeredBy;
  return merged;
}

export function selectDeliveryPayloads<T extends DeliverLike>(
  delivery: T,
  selected: readonly { readonly index: number; readonly payload: DeliverPayload }[],
): T {
  const metadata = selected.flatMap(({ index }, payloadIndex) =>
    (delivery.deliveryMetadata ?? [])
      .filter((entry) => entry.payloadIndex === index)
      .map((entry) => ({ ...entry, payloadIndex })),
  );
  return {
    ...delivery,
    payloads: selected.map(({ payload }) => payload),
    deliveryMetadata: metadata.length === 0 ? undefined : metadata,
  };
}
