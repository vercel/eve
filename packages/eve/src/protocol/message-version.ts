import {
  EVE_MESSAGE_STREAM_VERSION,
  type ActionInputAppendedStreamEvent,
  type MessageAppendedStreamEvent,
  type MessageStreamEvent,
  type MessageStreamEventMeta,
  type ReasoningAppendedStreamEvent,
  type UnstampedMessageStreamEvent,
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

interface MessageStreamAppendEventsByVersion {
  "21": MessageAppendedStreamEventV24 | ReasoningAppendedStreamEventV24;
  "22": MessageAppendedStreamEventV24 | ReasoningAppendedStreamEventV24;
  "23": MessageAppendedStreamEventV24 | ReasoningAppendedStreamEventV24;
  "24":
    | ActionInputAppendedStreamEventV24
    | MessageAppendedStreamEventV24
    | ReasoningAppendedStreamEventV24;
  "25": ActionInputAppendedStreamEvent | MessageAppendedStreamEvent | ReasoningAppendedStreamEvent;
}

export type MessageStreamVersion = keyof MessageStreamAppendEventsByVersion;
type LegacyMessageStreamVersion = Exclude<MessageStreamVersion, "25">;

type VersionIndependentMessageStreamEvent = Exclude<
  UnstampedMessageStreamEvent,
  ActionInputAppendedStreamEvent | MessageAppendedStreamEvent | ReasoningAppendedStreamEvent
>;

type UnstampedMessageStreamEventForVersion<Version extends MessageStreamVersion> =
  | VersionIndependentMessageStreamEvent
  | MessageStreamAppendEventsByVersion[Version];

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
      return validateCurrentMessageStreamEvent(event as MessageStreamEventForVersion<"25">);
    default:
      return assertNever(version);
  }
}

/** Normalizes a persisted stream that may contain events written before v25. */
export function normalizePersistedMessageStreamEvent(
  event: SupportedMessageStreamEvent,
): MessageStreamEvent {
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
    return {
      data: {
        messageDelta: event.data.messageDelta,
        startsBlock: legacyAppendStartsBlock(
          event.data.messageSoFar,
          event.data.messageDelta,
          "message",
          version,
        ),
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      },
      meta: event.meta,
      type: "message.appended",
    };
  }

  if (event.type === "reasoning.appended") {
    return {
      data: {
        reasoningDelta: event.data.reasoningDelta,
        startsBlock: legacyAppendStartsBlock(
          event.data.reasoningSoFar,
          event.data.reasoningDelta,
          "reasoning",
          version,
        ),
        sequence: event.data.sequence,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      },
      meta: event.meta,
      type: "reasoning.appended",
    };
  }

  if (event.type === "action.input.appended") {
    assertLegacyActionInputOffset(event.data.inputTextOffset, version);
    return {
      data: {
        callId: event.data.callId,
        inputTextDelta: event.data.inputTextDelta,
        sequence: event.data.sequence,
        startsBlock: event.data.inputTextOffset === 0,
        stepIndex: event.data.stepIndex,
        toolName: event.data.toolName,
        turnId: event.data.turnId,
      },
      meta: event.meta,
      type: "action.input.appended",
    };
  }

  return event;
}

function validateCurrentMessageStreamEvent(
  event: MessageStreamEventForVersion<"25">,
): MessageStreamEvent {
  if (event.type === "message.appended") {
    assertCurrentStartsBlock(event.data.startsBlock, "message");
  } else if (event.type === "reasoning.appended") {
    assertCurrentStartsBlock(event.data.startsBlock, "reasoning");
  } else if (event.type === "action.input.appended") {
    assertCurrentStartsBlock(event.data.startsBlock, "action input");
  }
  return event;
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported message stream version: ${String(value)}.`);
}

function assertCurrentStartsBlock(
  startsBlock: unknown,
  stream: "action input" | "message" | "reasoning",
): void {
  if (typeof startsBlock !== "boolean") {
    throw new TypeError(`Invalid ${stream} block boundary for stream version 25.`);
  }
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

function legacyAppendStartsBlock(
  snapshot: string,
  delta: string,
  stream: "message" | "reasoning",
  version: LegacyMessageStreamVersion | undefined,
): boolean {
  const offset = snapshot.length - delta.length;
  if (offset < 0 || snapshot.slice(offset) !== delta) {
    const source = version === undefined ? "persisted stream" : `stream version ${version}`;
    throw new TypeError(`Invalid cumulative ${stream} append for ${source}.`);
  }
  return offset === 0;
}
