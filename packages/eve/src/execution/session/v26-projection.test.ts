import { describe, expect, it, vi } from "vitest";

import { createV26HistoryReader, v26LineStream } from "#execution/v26-history.js";
import { KITCHEN_SINK, PENDING_APPROVAL } from "#execution/v26-history.fixtures.js";
import { rebuildV26Projection } from "#execution/session/v26-projection.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";
import type { CommitLine } from "#protocol/session-events/envelope.js";
import { schemaViolation } from "#protocol/session-events/schemas.js";
import {
  nextRunId,
  turnCoordinates,
  type SessionProjection,
} from "#protocol/session-projection.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";

const stored = vi.hoisted(() => ({ records: [] as unknown[] }));

vi.mock("#execution/session-event-stream.js", () => ({
  async *streamSessionLines() {
    for (const [position, record] of stored.records.entries()) yield { position, record };
  },
}));

function storeRecords(records: readonly unknown[]): void {
  stored.records = [...records];
}

describe("rebuildV26Projection", () => {
  it("continues an idle v26 stream at its next stored position and turn", async () => {
    storeRecords(KITCHEN_SINK);
    const rebuilt = await rebuildV26Projection("session-1", { nextTurnSequence: 0 });
    if (rebuilt.kind !== "rebuilt") throw new Error(rebuilt.detail);
    const { projection } = rebuilt;

    expect(projection.view.position).toBe(KITCHEN_SINK.length);
    expect(projection.view.session.status).toBe("open");
    // What a v27 reader folds from the same stored lines.
    const reader = createV26HistoryReader();
    const view = emptySessionView();
    KITCHEN_SINK.forEach((record, position) => {
      const line = reader.read(record, position);
      if (line !== undefined) foldLine(view, line, position, { retention: "operational" });
    });
    expect(projection.view.usage).toEqual(view.usage);
    expect(projection.view.session.latestTurnId).toBe(view.session.latestTurnId);
    const v26Turns = new Set(
      KITCHEN_SINK.flatMap((record) => {
        const { data, type } = record as { data?: { turnId?: unknown }; type: string };
        return type === "turn.started" ? [data?.turnId] : [];
      }),
    );
    expect(v26Turns.has(turnCoordinates(projection).turnId)).toBe(false);
  });

  it("accepts the next v27 turn after the stored v26 lines", async () => {
    storeRecords(KITCHEN_SINK);
    const rebuilt = await rebuildV26Projection("session-1", { nextTurnSequence: 0 });
    if (rebuilt.kind !== "rebuilt") throw new Error(rebuilt.detail);
    const line = nextTurnLine(rebuilt.projection, "Bob asks for the follow-up.");
    const position = rebuilt.projection.view.position;

    // The contract the writer checks its own lines against in development.
    const checker = createStreamChecker({
      seed: rebuilt.projection.view,
      validate: schemaViolation,
    });
    expect(checker.check(line, position)).toEqual([]);

    // A reader of the whole stream reads the v27 turn after the v26 history.
    const read = await collect(v26LineStream(ReadableStream.from([...KITCHEN_SINK, line]), 0));
    expect(read).toHaveLength(KITCHEN_SINK.length + 1);
    expect(read.at(-1)).toEqual(line);
  });

  it("keeps the v26 turn sequence and the spend its owner counted", async () => {
    storeRecords(KITCHEN_SINK);
    const usage = {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 90_000,
      outputTokens: 4_000,
    };
    const rebuilt = await rebuildV26Projection("session-1", {
      nextTurnSequence: 40,
      usage,
      usageWindow: { index: 2, start: { ...usage, inputTokens: 80_000 } },
    });
    if (rebuilt.kind !== "rebuilt") throw new Error(rebuilt.detail);

    expect(turnCoordinates(rebuilt.projection).turnId).toBe("turn_40");
    expect(rebuilt.projection.view.usage.total).toEqual(usage);
    expect(rebuilt.projection.usageWindow).toMatchObject({
      index: 2,
      start: { ...usage, inputTokens: 80_000 },
    });
  });

  it("refuses a stream whose session waits for an answer", async () => {
    storeRecords(PENDING_APPROVAL);
    await expect(rebuildV26Projection("session-1", { nextTurnSequence: 1 })).resolves.toEqual({
      kind: "refused",
      detail: expect.stringMatching(/open/),
    });
  });
});

/** One turn a v27 writer records from `projection`: admitted, answered in one run, settled. */
function nextTurnLine(projection: SessionProjection, message: string): CommitLine<SessionEvent> {
  const { turnId } = turnCoordinates(projection);
  const runId = nextRunId(projection);
  const deliveryId = "delivery-bob";
  const partId = `${runId}.0`;
  const scope = { turnId };
  return {
    at: "2026-10-28T00:00:00.000Z",
    facts: [
      { data: { deliveryId }, type: "delivery.admitted" },
      {
        data: {
          cause: { deliveryId },
          follows: projection.view.session.latestTurnId ?? null,
          turnId,
        },
        scope,
        type: "turn.started",
      },
      {
        data: { deliveryId, parts: [{ kind: "text", text: message }], turnId },
        scope,
        type: "delivery.consumed",
      },
      { data: { owner: { turnId }, runId }, scope: { runId, turnId }, type: "model.requested" },
      {
        data: { kind: "text", partId, phase: "reply", runId, value: "Here it is." },
        scope: { runId, turnId },
        type: "content.completed",
      },
      { data: { outcome: "completed", runId }, scope: { runId, turnId }, type: "model.settled" },
      { data: { outcome: "completed", reply: [partId], turnId }, scope, type: "turn.settled" },
      { data: { deliveryId, outcome: "handled", turnId }, type: "delivery.settled" },
    ] as SessionEvent[],
  };
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}
