import { buildTraceTurnsFromTranscript } from "./trace";
import type { ChatSessionCursor, ThreadState, TranscriptStreamEvent } from "./types";

const SESSION_STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
const SESSION_STREAM_INITIAL_TIMEOUT_MS = 5_000;
const SESSION_STREAM_REPLAY_IDLE_TIMEOUT_MS = 300;

export const EMPTY_CHAT_SESSION: ChatSessionCursor = {
  streamIndex: 0,
};

function createSessionTranscriptPath(sessionId: string): string {
  return `/eve/v1/session/${encodeURIComponent(sessionId)}/stream`;
}

function parseTranscriptStreamEvent(line: string): TranscriptStreamEvent {
  const parsed = JSON.parse(line) as unknown;

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("type" in parsed) ||
    typeof parsed.type !== "string"
  ) {
    throw new Error("Received an invalid transcript event.");
  }

  return parsed as TranscriptStreamEvent;
}

function createIdleTimeout(timeoutMs: number): {
  readonly cancel: () => void;
  readonly promise: Promise<"timeout">;
} {
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;

  return {
    cancel: () => {
      if (timeoutId !== undefined) {
        globalThis.clearTimeout(timeoutId);
      }
    },
    promise: new Promise((resolve) => {
      timeoutId = globalThis.setTimeout(() => {
        resolve("timeout");
      }, timeoutMs);
    }),
  };
}

async function readTranscriptEvents(sessionId: string): Promise<{
  readonly events: readonly TranscriptStreamEvent[];
  readonly eventsRead: number;
}> {
  const response = await fetch(createSessionTranscriptPath(sessionId), {
    headers: {
      accept: SESSION_STREAM_CONTENT_TYPE,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body.length > 0 ? body : `Request failed (${response.status}).`);
  }

  if (response.body === null) {
    throw new Error("Transcript response did not include a readable body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: TranscriptStreamEvent[] = [];
  let buffer = "";
  let reachedStreamEnd = false;
  let sawEvent = false;

  const pushLine = (line: string): void => {
    events.push(parseTranscriptStreamEvent(line));
    sawEvent = true;
  };

  try {
    while (true) {
      const timeoutMs = sawEvent
        ? SESSION_STREAM_REPLAY_IDLE_TIMEOUT_MS
        : SESSION_STREAM_INITIAL_TIMEOUT_MS;
      const idleTimeout = createIdleTimeout(timeoutMs);
      const result = await Promise.race([reader.read(), idleTimeout.promise]);
      idleTimeout.cancel();

      if (result === "timeout") {
        break;
      }

      const { done, value } = result;

      if (done) {
        buffer += decoder.decode();
        reachedStreamEnd = true;
        break;
      }

      buffer += decoder.decode(value, {
        stream: true,
      });

      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }

        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line.length === 0) {
          continue;
        }

        pushLine(line);
      }
    }

    if (reachedStreamEnd) {
      const trailingLine = buffer.trim();
      if (trailingLine.length > 0) {
        pushLine(trailingLine);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  return {
    events,
    eventsRead: events.length,
  };
}

/**
 * Loads the transcript-derived thread state from the persisted session stream.
 */
export async function loadThreadViewFromTranscript(sessionId: string): Promise<{
  readonly eventsRead: number;
  readonly thread: ThreadState;
}> {
  const transcript = await readTranscriptEvents(sessionId);
  const turns = buildTraceTurnsFromTranscript(transcript.events);

  return {
    eventsRead: transcript.eventsRead,
    thread: {
      sessionId,
      streamIndex: transcript.eventsRead,
      turns,
    },
  };
}

/**
 * Rebuilds one thread from the already-rendered transcript prefix plus the
 * newest streamed events for the active turn.
 */
export function mergeThreadStreamEvents(input: {
  readonly baseThread?: ThreadState;
  readonly sessionId: string;
  readonly startIndex: number;
  readonly streamEvents: readonly TranscriptStreamEvent[];
}): ThreadState {
  const existingEvents = input.baseThread?.turns.flatMap((turn) => turn.events) ?? [];
  const transcriptEvents = [
    ...existingEvents.slice(0, Math.min(input.startIndex, existingEvents.length)),
    ...input.streamEvents,
  ];

  return {
    continuationToken: input.baseThread?.continuationToken,
    sessionId: input.sessionId,
    streamIndex: input.startIndex + input.streamEvents.length,
    turns: buildTraceTurnsFromTranscript(transcriptEvents),
  };
}

/**
 * Returns the continuation token that should stay attached to the active
 * thread while a turn is streaming.
 */
export function resolveContinuationToken(input: {
  readonly currentContinuationToken?: string;
  readonly nextContinuationToken?: string;
}): string | undefined {
  if (typeof input.nextContinuationToken === "string" && input.nextContinuationToken.length > 0) {
    return input.nextContinuationToken;
  }

  return input.currentContinuationToken;
}

/**
 * Seeds the in-memory streaming thread with the live continuation token so the
 * active session does not briefly look replay-only while events are arriving.
 */
export function createStreamingThreadBase(input: {
  readonly baseThread?: ThreadState;
  readonly continuationToken?: string;
  readonly sessionId: string;
  readonly startIndex: number;
}): ThreadState | undefined {
  if (input.baseThread !== undefined) {
    if (
      input.continuationToken === undefined ||
      input.baseThread.continuationToken === input.continuationToken
    ) {
      return input.baseThread;
    }

    return {
      continuationToken: input.continuationToken,
      sessionId: input.baseThread.sessionId,
      streamIndex: input.baseThread.streamIndex,
      turns: input.baseThread.turns,
    };
  }

  if (input.continuationToken === undefined) {
    return undefined;
  }

  return {
    continuationToken: input.continuationToken,
    sessionId: input.sessionId,
    streamIndex: input.startIndex,
    turns: [],
  };
}

/**
 * Returns whether the selected thread should be hydrated from cached or
 * persisted history for the current render pass.
 */
export function shouldHydrateSelectedThread(input: {
  readonly isComposeInProgress: boolean;
  readonly lastHydratedSessionId: string | null;
  readonly selectedSessionId: string | null;
}): boolean {
  return (
    input.selectedSessionId !== null &&
    input.selectedSessionId !== input.lastHydratedSessionId &&
    !input.isComposeInProgress
  );
}

/**
 * Returns whether the selected thread is a history-only replay that cannot
 * accept a follow-up message.
 */
export function isReplayOnlyThread(input: {
  readonly isComposeInProgress: boolean;
  readonly selectedSessionId: string | null;
  readonly selectedThreadState?: ThreadState;
}): boolean {
  return (
    input.selectedSessionId !== null &&
    input.selectedThreadState !== undefined &&
    input.selectedThreadState.continuationToken === undefined &&
    !input.isComposeInProgress
  );
}
