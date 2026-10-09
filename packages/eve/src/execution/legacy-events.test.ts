import { describe, expect, it } from "vitest";

import { createLegacyEventTranslator } from "#execution/legacy-events.js";
import { stepProjection } from "#harness/session-machine/current.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { eventsOfLine, linesOf } from "#protocol/session-lines.js";

const AT = "2026-01-01T00:00:00.000Z";
const RUN = { runId: "run_0", turnId: "turn_0" } as const;

/** Writes each publication as a session does, and translates every line it writes. */
function translate(publications: readonly (readonly SessionEvent[])[]): MessageStreamEvent[] {
  const projection = stepProjection(undefined, undefined);
  const translator = createLegacyEventTranslator();
  const out: MessageStreamEvent[] = [];
  for (const publication of publications) {
    for (const line of linesOf(publication, AT)) {
      const before = projection.read();
      const position = before.position ?? 0;
      const events = eventsOfLine(line, position, AT);
      projection.record("facts" in line ? line.facts : [line.progress]);
      const after = projection.read();
      out.push(
        ...translator
          .translate(
            { after, at: AT, before, events, position },
            { continuationToken: "telegram:1", sessionId: "session_1" },
          )
          .flat(),
      );
    }
  }
  return out;
}

const shape = (events: readonly MessageStreamEvent[]) =>
  events.map((event) => ({ data: "data" in event ? event.data : undefined, type: event.type }));

describe("legacy event translation", () => {
  it("reports a turn that narrates, calls a tool, and replies as v26 did", () => {
    const events = translate([
      [{ data: {}, type: "session.started" }],
      [
        { data: { deliveryId: "d1", source: { channel: "http" } }, type: "delivery.admitted" },
        {
          data: { cause: { deliveryId: "d1" }, follows: null, turnId: "turn_0" },
          type: "turn.started",
        },
        {
          data: {
            deliveryId: "d1",
            parts: [{ kind: "text", text: "Deploy it" }],
            turnId: "turn_0",
          },
          scope: { turnId: "turn_0" },
          type: "delivery.consumed",
        },
      ],
      [
        {
          data: { owner: { turnId: "turn_0" }, runId: "run_0" },
          scope: RUN,
          type: "model.requested",
        },
        { data: { modelId: "test-model", runId: "run_0" }, scope: RUN, type: "model.started" },
      ],
      [
        {
          data: { delta: "Deploying", kind: "text", partId: "run_0.p0" },
          scope: RUN,
          type: "content.delta",
        },
      ],
      [{ data: { delta: " now.", partId: "run_0.p0" }, scope: RUN, type: "content.delta" }],
      [
        {
          data: {
            kind: "text",
            partId: "run_0.p0",
            phase: "narration",
            runId: "run_0",
            value: "Deploying now.",
          },
          scope: RUN,
          type: "content.completed",
        },
        {
          data: {
            callId: "call_1",
            capability: { kind: "tool", name: "deploy" },
            input: { env: "prod" },
            owner: { runId: "run_0" },
          },
          scope: RUN,
          type: "call.requested",
        },
      ],
      [{ data: { callId: "call_1" }, scope: RUN, type: "call.started" }],
      [
        {
          data: { callId: "call_1", outcome: "completed", output: "ok" },
          scope: RUN,
          type: "call.settled",
        },
        {
          data: {
            kind: "text",
            partId: "run_0.p1",
            phase: "reply",
            runId: "run_0",
            value: "Deployed.",
          },
          scope: RUN,
          type: "content.completed",
        },
        {
          data: {
            kind: "model",
            owner: { runId: "run_0" },
            usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10, outputTokens: 5 },
          },
          scope: RUN,
          type: "usage.recorded",
        },
        {
          data: { finishReason: "stop", outcome: "completed", runId: "run_0" },
          scope: RUN,
          type: "model.settled",
        },
      ],
      [
        {
          data: { outcome: "completed", reply: ["run_0.p1"], turnId: "turn_0" },
          type: "turn.settled",
        },
        {
          data: { deliveryId: "d1", outcome: "handled", turnId: "turn_0" },
          type: "delivery.settled",
        },
      ],
    ]);

    const at = { sequence: 0, stepIndex: 0, turnId: "turn_0" };
    expect(shape(events)).toEqual([
      { data: {}, type: "session.started" },
      { data: { sequence: 0, turnId: "turn_0" }, type: "turn.started" },
      {
        data: {
          message: "Deploy it",
          parts: [{ text: "Deploy it", type: "text" }],
          sequence: 0,
          turnId: "turn_0",
        },
        type: "message.received",
      },
      { data: { modelId: "test-model", ...at }, type: "step.started" },
      { data: { messageDelta: "Deploying", ...at }, type: "message.appended" },
      { data: { messageDelta: " now.", ...at }, type: "message.appended" },
      {
        data: { finishReason: "tool-calls", message: "Deploying now.", ...at },
        type: "message.completed",
      },
      {
        data: {
          actions: [
            { callId: "call_1", input: { env: "prod" }, kind: "tool-call", toolName: "deploy" },
          ],
          ...at,
        },
        type: "actions.requested",
      },
      {
        data: {
          result: { callId: "call_1", kind: "tool-result", output: "ok", toolName: "deploy" },
          status: "completed",
          ...at,
        },
        type: "action.result",
      },
      { data: { finishReason: "stop", message: "Deployed.", ...at }, type: "message.completed" },
      {
        data: {
          finishReason: "stop",
          usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10, outputTokens: 5 },
          ...at,
        },
        type: "step.completed",
      },
      { data: { sequence: 0, turnId: "turn_0" }, type: "turn.completed" },
      {
        data: {
          continuationToken: "telegram:1",
          usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10, outputTokens: 5 },
          wait: "next-user-message",
        },
        type: "session.waiting",
      },
    ]);
  });

  it("stamps deterministic, ordered ids", () => {
    const events = translate([
      [{ data: {}, type: "session.started" }],
      [
        {
          data: { cause: { hook: "test" }, follows: null, turnId: "turn_0" },
          type: "turn.started",
        },
        { data: { outcome: "cancelled", turnId: "turn_0" }, type: "turn.settled" },
      ],
    ]);
    const ids = events.map((event) => event.meta.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "turn.cancelled",
      "session.waiting",
    ]);
  });

  it("reports an approval request and its decision once per line", () => {
    const events = translate([
      [{ data: {}, type: "session.started" }],
      [
        {
          data: { cause: { hook: "test" }, follows: null, turnId: "turn_0" },
          type: "turn.started",
        },
      ],
      [
        {
          data: { owner: { turnId: "turn_0" }, runId: "run_0" },
          scope: RUN,
          type: "model.requested",
        },
        {
          data: {
            callId: "call_1",
            capability: { kind: "tool", name: "deploy" },
            input: { env: "prod" },
            owner: { runId: "run_0" },
          },
          scope: RUN,
          type: "call.requested",
        },
        {
          data: {
            interactionId: "call_1",
            request: { kind: "approval", prompt: "Deploy to prod?" },
            subject: { callId: "call_1" },
          },
          scope: { turnId: "turn_0" },
          type: "interaction.opened",
        },
        {
          data: { awaiting: [{ interactionId: "call_1" }], turnId: "turn_0" },
          type: "turn.paused",
        },
      ],
      [
        {
          data: { interactionId: "call_1", outcome: "accepted" },
          scope: { turnId: "turn_0" },
          type: "interaction.settled",
        },
      ],
    ]);
    const types = events.map((event) => event.type);
    expect(types).toEqual([
      "session.started",
      "turn.started",
      "actions.requested",
      "input.requested",
      "turn.waiting",
      "input.resolved",
    ]);
    const requested = events.find((event) => event.type === "input.requested");
    expect(requested?.type === "input.requested" && requested.data.requests).toMatchObject([
      {
        action: { callId: "call_1", input: { env: "prod" }, toolName: "deploy" },
        kind: "tool-approval",
        prompt: "Deploy to prod?",
        requestId: "call_1",
      },
    ]);
    const resolved = events.find((event) => event.type === "input.resolved");
    expect(resolved?.type === "input.resolved" && resolved.data.resolutions).toEqual([
      { kind: "tool-approval", outcome: "approved", requestId: "call_1" },
    ]);
  });
});
