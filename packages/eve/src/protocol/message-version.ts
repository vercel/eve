import {
  EVE_MESSAGE_STREAM_VERSION,
  type ActionInputAppendedStreamEvent,
  type MessageAppendedStreamEvent,
  type MessageStreamEvent,
  type MessageStreamEventMeta,
  type ReasoningAppendedStreamEvent,
  type UnstampedMessageStreamEvent,
  type SubagentCompletedStreamEvent,
  type SubagentAdmittedStreamEvent,
} from "#protocol/message.js";

interface MessageAppendedStreamEventV24 {
  data: {
    messageDelta: string;
    messageSoFar: string;
    sequence: number;
    stepIndex: number;
    turnId: string;
  };
  type: "message.appended";
}

interface ReasoningAppendedStreamEventV24 {
  data: {
    reasoningDelta: string;
    reasoningSoFar: string;
    sequence: number;
    stepIndex: number;
    turnId: string;
  };
  type: "reasoning.appended";
}

interface ActionInputAppendedStreamEventV24 {
  data: {
    callId: string;
    inputTextDelta: string;
    inputTextOffset: number;
    sequence: number;
    stepIndex: number;
    toolName: string;
    turnId: string;
  };
  type: "action.input.appended";
}

interface SubagentCompletedStreamEventV25 {
  type: "subagent.completed";
  data: SubagentCompletedStreamEvent["data"] & {
    backgroundTask?: SubagentAdmittedStreamEvent["data"]["backgroundTask"];
  };
}

interface MessageStreamAppendEventsByVersion {
  "21": MessageAppendedStreamEventV24 | ReasoningAppendedStreamEventV24;
  "22": MessageAppendedStreamEventV24 | ReasoningAppendedStreamEventV24;
  "23": MessageAppendedStreamEventV24 | ReasoningAppendedStreamEventV24;
  "24":
    | ActionInputAppendedStreamEventV24
    | MessageAppendedStreamEventV24
    | ReasoningAppendedStreamEventV24;
  "25": ActionInputAppendedStreamEvent | MessageAppendedStreamEvent | ReasoningAppendedStreamEvent;
  "26": ActionInputAppendedStreamEvent | MessageAppendedStreamEvent | ReasoningAppendedStreamEvent;
}

export type MessageStreamVersion = keyof MessageStreamAppendEventsByVersion;
type LegacyMessageStreamVersion = Exclude<MessageStreamVersion, "25" | "26">;

type VersionIndependentMessageStreamEvent = Exclude<
  UnstampedMessageStreamEvent,
  | ActionInputAppendedStreamEvent
  | MessageAppendedStreamEvent
  | ReasoningAppendedStreamEvent
  | SubagentCompletedStreamEvent
  | SubagentAdmittedStreamEvent
>;

type UnstampedMessageStreamEventForVersion<Version extends MessageStreamVersion> =
  | VersionIndependentMessageStreamEvent
  | MessageStreamAppendEventsByVersion[Version]
  | (Version extends "26"
      ? SubagentCompletedStreamEvent | SubagentAdmittedStreamEvent
      : SubagentCompletedStreamEventV25);

export type MessageStreamEventForVersion<Version extends MessageStreamVersion> =
  UnstampedMessageStreamEventForVersion<Version> & {
    readonly meta: MessageStreamEventMeta;
  };

type SupportedMessageStreamEvent = MessageStreamEventForVersion<MessageStreamVersion>;

const currentMessageStreamVersion = EVE_MESSAGE_STREAM_VERSION satisfies MessageStreamVersion;

/** Normalizes one event from a declared wire version into the current event contract. */
export function normalizeMessageStreamEvent<Version extends MessageStreamVersion>(
  version: Version,
  event: MessageStreamEventForVersion<Version>,
): MessageStreamEvent;
export function normalizeMessageStreamEvent(
  version: MessageStreamVersion,
  event: SupportedMessageStreamEvent,
): MessageStreamEvent {
  switch (version) {
    case "21":
    case "22":
    case "23":
    case "24":
      return normalizeLegacyMessageStreamEvent(
        version,
        event as MessageStreamEventForVersion<LegacyMessageStreamVersion>,
      );
    case "25":
      if (event.type === "subagent.completed") return normalizeSubagentCompletion(event);
      return validateCurrentMessageStreamEvent(
        event as MessageStreamEventForVersion<"26">,
        version,
      );
    case "26":
      return validateCurrentMessageStreamEvent(
        event as MessageStreamEventForVersion<"26">,
        version,
      );
    default:
      return assertNever(version);
  }
}

/** Normalizes a persisted stream that may contain earlier append formats or background admission receipts. */
export function normalizePersistedMessageStreamEvent(
  event: SupportedMessageStreamEvent,
): MessageStreamEvent {
  if (event.type === "subagent.completed") return normalizeSubagentCompletion(event);
  if (
    (event.type === "message.appended" && "messageSoFar" in event.data) ||
    (event.type === "reasoning.appended" && "reasoningSoFar" in event.data) ||
    (event.type === "action.input.appended" && "inputTextOffset" in event.data)
  ) {
    return normalizeLegacyMessageStreamEvent(
      undefined,
      event as MessageStreamEventForVersion<LegacyMessageStreamVersion>,
    );
  }
  return normalizeMessageStreamEvent(
    currentMessageStreamVersion,
    event as MessageStreamEventForVersion<typeof currentMessageStreamVersion>,
  );
}

function normalizeLegacyMessageStreamEvent(
  version: LegacyMessageStreamVersion | undefined,
  event: MessageStreamEventForVersion<LegacyMessageStreamVersion>,
): MessageStreamEvent {
  if (event.type === "message.appended") {
    assertLegacyAppendSnapshot(
      event.data.messageSoFar,
      event.data.messageDelta,
      "message",
      version,
    );
    return {
      data: {
        messageDelta: event.data.messageDelta,
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      },
      meta: event.meta,
      type: "message.appended",
    };
  }

  if (event.type === "reasoning.appended") {
    assertLegacyAppendSnapshot(
      event.data.reasoningSoFar,
      event.data.reasoningDelta,
      "reasoning",
      version,
    );
    return {
      data: {
        reasoningDelta: event.data.reasoningDelta,
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      },
      meta: event.meta,
      type: "reasoning.appended",
    };
  }

  if (event.type === "action.input.appended") {
    if (version !== undefined && version !== "24") {
      throw new TypeError(`Invalid action input append for stream version ${version}.`);
    }
    assertLegacyActionInputOffset(event.data.inputTextOffset, version);
    return {
      data: {
        callId: event.data.callId,
        inputTextDelta: event.data.inputTextDelta,
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        toolName: event.data.toolName,
        turnId: event.data.turnId,
      },
      meta: event.meta,
      type: "action.input.appended",
    };
  }

  return event.type === "subagent.completed" ? normalizeSubagentCompletion(event) : event;
}

/** Older streams reported background admission using the completion event. */
function normalizeSubagentCompletion(
  event: SubagentCompletedStreamEventV25 & { readonly meta: MessageStreamEventMeta },
): MessageStreamEvent {
  const { backgroundTask, ...data } = event.data;
  return backgroundTask === undefined
    ? { ...event, data }
    : { ...event, type: "subagent.admitted", data: { ...data, backgroundTask } };
}

function validateCurrentMessageStreamEvent(
  event: MessageStreamEventForVersion<"26">,
  version: "25" | "26",
): MessageStreamEvent {
  if (event.type === "subagent.completed" && "backgroundTask" in event.data) {
    throw new TypeError("Background admission requires subagent.admitted in stream version 26.");
  }
  if (event.type === "message.appended") {
    assertCurrentAppendDelta(event.data.messageDelta, "message", version);
    assertUnsupportedAppendField(event.data, "messageOffset", "message", version);
    assertUnsupportedAppendField(event.data, "messageSoFar", "message", version);
  } else if (event.type === "reasoning.appended") {
    assertCurrentAppendDelta(event.data.reasoningDelta, "reasoning", version);
    assertUnsupportedAppendField(event.data, "reasoningOffset", "reasoning", version);
    assertUnsupportedAppendField(event.data, "reasoningSoFar", "reasoning", version);
  } else if (event.type === "action.input.appended") {
    assertCurrentAppendDelta(event.data.inputTextDelta, "action input", version);
    assertUnsupportedAppendField(event.data, "inputTextOffset", "action input", version);
  }
  return event;
}

function assertCurrentAppendDelta(
  delta: unknown,
  stream: "action input" | "message" | "reasoning",
  version: "25" | "26",
): void {
  if (typeof delta !== "string") {
    throw new TypeError(`Invalid ${stream} append delta for stream version ${version}.`);
  }
}

function assertUnsupportedAppendField(
  data: object,
  field: string,
  stream: "action input" | "message" | "reasoning",
  version: "25" | "26",
): void {
  if (field in data) {
    throw new TypeError(`Invalid ${stream} append shape for stream version ${version}.`);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported message stream version: ${String(value)}.`);
}

function assertLegacyActionInputOffset(
  offset: unknown,
  version: LegacyMessageStreamVersion | undefined,
): void {
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
    const source = version === undefined ? "persisted stream" : `stream version ${version}`;
    throw new TypeError(`Invalid action input append offset for ${source}.`);
  }
}

function assertLegacyAppendSnapshot(
  snapshot: string,
  delta: string,
  stream: "message" | "reasoning",
  version: LegacyMessageStreamVersion | undefined,
): void {
  const offset = snapshot.length - delta.length;
  if (offset < 0 || snapshot.slice(offset) !== delta) {
    const source = version === undefined ? "persisted stream" : `stream version ${version}`;
    throw new TypeError(`Invalid cumulative ${stream} append for ${source}.`);
  }
}
