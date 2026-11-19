import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";
import { ResponseSegment, summarizeTurnEvents } from "#client/session-utils.js";
import { createEventReader, linesOf } from "#protocol/session-lines.js";
import { isStoredLine } from "#protocol/session-events/envelope.js";

export interface WorkflowRunHandle {
  readonly readable: ReadableStream<Uint8Array>;
  cancel(): Promise<void>;
}

export interface CapturedTurnStream {
  nextTurn(): Promise<SessionStreamEvent[]>;
  nextUntil(matches: (event: SessionStreamEvent) => boolean): Promise<SessionStreamEvent[]>;
  dispose(): void;
}

export function captureTurnEvents(
  run: WorkflowRunHandle,
  options: CaptureTurnEventsOptions = {},
): CapturedTurnStream {
  const reader = run.readable.getReader();
  const state: StreamState = {
    buffer: "",
    lines: createEventReader(),
    pending: [],
    position: 0,
  };
  const decoder = options.decoder ?? new TextDecoder();
  let disposed = false;
  const readUntil = async (matches: (event: SessionStreamEvent) => boolean) => {
    if (disposed) {
      throw new Error("CapturedTurnStream: stream already disposed.");
    }

    return await readUntilMatch(reader, state, decoder, matches);
  };

  return {
    async nextTurn() {
      const segment = new ResponseSegment();
      return await readUntil((event) => segment.observe(event));
    },
    async nextUntil(matches) {
      return await readUntil(matches);
    },
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      reader.releaseLock();
    },
  };
}

export async function readFirstTurnReply(run: WorkflowRunHandle): Promise<string | null> {
  const stream = captureTurnEvents(run);
  try {
    const turn = await stream.nextTurn();
    return summarizeTurnEvents(turn).message ?? null;
  } finally {
    stream.dispose();
    await run.cancel();
  }
}

export function containsEventSequence(
  events: readonly SessionEvent[],
  types: readonly SessionEvent["type"][],
): boolean {
  if (types.length === 0) {
    return true;
  }

  let cursor = 0;

  for (const event of events) {
    if (event.type === types[cursor]) {
      cursor += 1;

      if (cursor === types.length) {
        return true;
      }
    }
  }

  return false;
}

export function filterEventsByType<T extends SessionEvent["type"]>(
  events: readonly SessionEvent[],
  type: T,
): Array<Extract<SessionEvent, { type: T }>> {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

interface CaptureTurnEventsOptions {
  readonly decoder?: InstanceType<typeof TextDecoder>;
}

interface StreamState {
  buffer: string;
  position: number;
  pending: SessionStreamEvent[];
  readonly lines: ReturnType<typeof createEventReader>;
}

async function readUntilMatch(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: StreamState,
  decoder: InstanceType<typeof TextDecoder>,
  matches: (event: SessionStreamEvent) => boolean,
): Promise<SessionStreamEvent[]> {
  const events: SessionStreamEvent[] = [];

  while (true) {
    while (state.pending.length > 0) {
      const event = state.pending.shift() as SessionStreamEvent;
      events.push(event);
      if (matches(event)) return events;
    }
    const newlineIndex = state.buffer.indexOf("\n");
    if (newlineIndex !== -1) {
      const line = state.buffer.slice(0, newlineIndex).trim();
      state.buffer = state.buffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      const value: unknown = JSON.parse(line);
      const position = state.position;
      state.position += 1;
      if (isStoredLine(value)) state.pending.push(...state.lines.read(value, position));
      continue;
    }

    const { done, value } = await reader.read();
    if (done) {
      throw new Error("Workflow stream closed before reaching a turn boundary.");
    }
    state.buffer += decoder.decode(value, { stream: true });
  }
}

export function stampTestEvent(event: SessionEvent, index = 0): SessionStreamEvent {
  return {
    ...event,
    meta: {
      at: new Date(Date.UTC(2026, 0, 1) + index).toISOString(),
      position: { line: index, index: 0 },
      endOfLine: true,
    },
  };
}

export function stampTestEvents(events: readonly SessionEvent[]): SessionStreamEvent[] {
  return events.map((event, index) => stampTestEvent(event, index));
}

export const TEST_USAGE = {
  cacheReadTokens: 800,
  cacheWriteTokens: 0,
  costUsd: 0.0042,
  inputTokens: 1200,
  outputTokens: 150,
};

export function encodeTestLine(event: SessionEvent): string {
  return linesOf([event], new Date(Date.UTC(2026, 0, 1)).toISOString())
    .map((line) => `${JSON.stringify(line)}\n`)
    .join("");
}

export function testTurnFacts(
  sequence: number,
  message: string,
  deliveryIds: readonly string[],
): SessionEvent[] {
  const turnId = `turn_${sequence}`;
  const runId = `run_${sequence}`;
  const partId = `part_${sequence}`;
  const scope = { turnId };
  return [
    ...deliveryIds.map((deliveryId): SessionEvent => ({
      data: { deliveryId },
      type: "delivery.admitted",
    })),
    {
      data: {
        cause: { deliveryId: deliveryIds[0] ?? "none" },
        follows: sequence === 0 ? null : `turn_${sequence - 1}`,
        turnId,
      },
      scope,
      type: "turn.started",
    },
    ...deliveryIds.map((deliveryId): SessionEvent => ({
      data: { deliveryId, parts: [{ kind: "text", text: message.toLowerCase() }], turnId },
      scope,
      type: "delivery.consumed",
    })),
    { data: { owner: { turnId }, runId }, scope: { runId, turnId }, type: "model.requested" },
    {
      data: { kind: "text", partId, phase: "reply", runId, value: message },
      scope: { runId, turnId },
      type: "content.completed",
    },
    { data: { outcome: "completed", runId }, scope: { runId, turnId }, type: "model.settled" },
    { data: { outcome: "completed", reply: [partId], turnId }, scope, type: "turn.settled" },
    ...deliveryIds.map((deliveryId): SessionEvent => ({
      data: { deliveryId, outcome: "handled", turnId },
      type: "delivery.settled",
    })),
  ];
}
