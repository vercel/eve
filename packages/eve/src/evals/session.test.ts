import { captureLogRecords } from "#internal/testing/log-records.js";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import { MessageResponse } from "#client/message-response.js";
import { ClientSession } from "#client/session.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import { createEvalContext } from "#evals/context.js";
import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import { EvalSessionManager } from "#evals/session-manager.js";
import { createEvalTargetHandle } from "#evals/target.js";
import { stampTestEvents } from "#internal/testing/events.js";
import type { MessageStreamEvent } from "#protocol/message.js";

const mocks = vi.hoisted(() => ({ decide: vi.fn() }));

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("#ai/decide.js", () => ({ decide: mocks.decide }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("eval judge input", () => {
  it.each(["respond", "startRespond", "readTurn"] as const)(
    "preserves the latest prompt after %s",
    async (operation) => {
      const { context, session } = await setup();
      await session.send("Find Alice's order status.");
      await session.send("Find Bob's order status instead.");

      const responses = [{ requestId: "approval_1", optionId: "approve" }];
      if (operation === "startRespond") {
        await (await session.startRespond(responses)).result();
      } else if (operation === "respond") {
        await session.respond(responses);
      } else {
        await session.readTurn();
      }

      context.judge("answers the user's request");
      expect(mocks.decide).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({ input: "Find Bob's order status instead." }),
        }),
      );
    },
  );

  it("uses the text supplied with a file attachment", async () => {
    const { context, session } = await setup();
    vi.mocked(readFile).mockResolvedValue(Buffer.from("invoice"));

    await session.sendFile("Summarize Alice's invoice.", "/invoice.txt", "text/plain");
    context.judge("summarizes the invoice");

    expect(mocks.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ input: "Summarize Alice's invoice." }),
      }),
    );
  });

  it("combines multipart text and clears the previous prompt for a file-only message", async () => {
    const { context, session } = await setup();
    const file = {
      type: "file",
      data: "data:text/plain;base64,SGk=",
      mediaType: "text/plain",
    } as const;

    await session.send([
      { type: "text", text: "Review Alice's invoice." },
      file,
      { type: "text", text: "List the line items." },
    ]);
    context.judge("lists the line items");
    expect(mocks.decide).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ input: "Review Alice's invoice.\nList the line items." }),
      }),
    );

    await session.send([file]);
    context.judge("describes the attachment");
    expect(mocks.decide).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: expect.objectContaining({ input: "" }) }),
    );
  });
});

describe("eval session compact", () => {
  it("returns the compaction events through session.waiting", async () => {
    const { session } = await setup();
    await session.send("Plan Alice's trip.");
    const compact = vi
      .spyOn(ClientSession.prototype, "compact")
      .mockResolvedValue({ sessionId: "session_1", status: "accepted" });
    vi.mocked(ClientSession.prototype.stream).mockImplementation(compactionEvents);

    const compacted = await session.compact();

    expect(compact).toHaveBeenCalledOnce();
    expect(compacted.events.map((event) => event.type)).toEqual([
      "compaction.requested",
      "compaction.completed",
      "session.waiting",
    ]);
  });

  it("throws instead of waiting when the session is no longer active", async () => {
    const { session } = await setup();
    vi.spyOn(ClientSession.prototype, "compact").mockResolvedValue({
      status: "no_active_session",
    });

    await expect(session.compact()).rejects.toThrow(/no active session/);
    expect(ClientSession.prototype.stream).not.toHaveBeenCalled();
  });
});

describe("eval session clock", () => {
  it("records when each send was accepted and when each event arrived", async () => {
    const { session } = await setup();
    const receipt = { deliveryId: "delivery_1", startedAt: 10, notReadyMs: 5, acceptedAt: 20 };
    vi.mocked(ClientSession.prototype.send).mockImplementationOnce(
      async () =>
        new MessageResponse({
          sessionId: "session_1",
          cancelTurn: async () => ({ status: "no_active_turn" }),
          createStream: events,
          receipt,
        }),
    );

    await session.send("Find Alice's order status.");

    const { clock, events: captured } = session.snapshot();
    expect(clock?.sends).toEqual([
      {
        kind: "prewarm",
        startedAt: expect.any(Number),
        notReadyMs: 0,
        acceptedAt: expect.any(Number),
      },
      { kind: "message", ...receipt },
    ]);
    expect(captured.length).toBeGreaterThan(0);
    expect(clock?.receivedAt).toHaveLength(captured.length);
    expect(clock?.receivedAt.every(Number.isFinite)).toBe(true);
  });
});

describe("eval session partial respond", () => {
  // https://github.com/vercel/eve/issues/5157
  it("keeps the unanswered request pending", async () => {
    const { session } = await answerOneOfTwoApprovals();

    expect(session.pendingInputRequests.map((request) => request.requestId)).toEqual([
      "approval_web",
    ]);
  });

  // https://github.com/vercel/eve/issues/5157
  it("reports the run and the respond turn as parked on the unanswered request", async () => {
    const { collector, session, turn } = await answerOneOfTwoApprovals();
    turn.parked();
    turn.succeeded();

    expect(session.snapshot().derived.parked).toBe(true);
    const outcomes = await collector.finalize({
      derived: createEmptyDerivedFacts(),
      events: [],
      finalMessage: null,
      output: null,
      status: "completed",
      traceContexts: [],
    });
    expect(outcomes.map(({ name, passed }) => ({ name, passed }))).toEqual([
      { name: "parked", passed: true },
      { name: "succeeded", passed: false },
    ]);
  });
});

/**
 * Parks on two approvals, then answers only the first. The runtime settles it and parks the
 * same turn again on the second without re-raising it: `approval.settled`, `turn.waiting`.
 */
async function answerOneOfTwoApprovals() {
  const { collector, session } = await setup();
  vi.mocked(ClientSession.prototype.send).mockImplementation(async () =>
    response(async function* () {
      yield* stampTestEvents([
        {
          type: "input.requested",
          data: {
            requests: ["api", "web"].map((service) => ({
              action: {
                callId: `call_${service}`,
                input: { service },
                kind: "tool-call" as const,
                toolName: "deploy_service",
              },
              kind: "tool-approval" as const,
              prompt: `Deploy ${service}?`,
              requestId: `approval_${service}`,
            })),
            sequence: 1,
            stepIndex: 0,
            turnId: "turn_1",
          },
        },
        { type: "turn.waiting", data: { on: "input", sequence: 2, turnId: "turn_1" } },
      ]);
    }),
  );
  vi.mocked(ClientSession.prototype.respond).mockImplementation(async () =>
    response(async function* () {
      yield* stampTestEvents([
        {
          type: "approval.settled",
          data: {
            outcome: "approved",
            requestId: "approval_api",
            responderPrincipalId: "alice",
            sequence: 3,
            stepIndex: 0,
            turnId: "turn_1",
          },
        },
        { type: "turn.waiting", data: { on: "input", sequence: 4, turnId: "turn_1" } },
      ]);
    }),
  );

  await session.send("Deploy Alice's api and web services.");
  const turn = await session.respond([{ requestId: "approval_api", optionId: "approve" }]);
  return { collector, session, turn };
}

async function setup() {
  mocks.decide.mockResolvedValue({
    answers: { judgment: { type: "boolean", probability: 1 } },
    response: { modelId: "test" },
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ sessionId: "session_1" }, { status: 202 }),
  );
  vi.spyOn(ClientSession.prototype, "send").mockImplementation(async () => response());
  vi.spyOn(ClientSession.prototype, "respond").mockImplementation(async () => response());
  vi.spyOn(ClientSession.prototype, "stream").mockImplementation(events);
  const client = new Client({ host: "https://eve.test" });
  const collector = new AssertionCollector();
  const manager = new EvalSessionManager({ client, collector });
  const { context } = createEvalContext({
    collector,
    manager,
    target: createEvalTargetHandle({
      capabilities: { devRoutes: true },
      client,
      kind: "local",
      url: "https://eve.test",
    }),
    signal: new AbortController().signal,
    judge: { model: "openai/gpt-5.4-mini" },
    log: () => {},
  });
  return { collector, context, session: await manager.session() };
}

function response(createStream: () => AsyncGenerator<MessageStreamEvent> = events) {
  return new MessageResponse({
    sessionId: "session_1",
    cancelTurn: async () => ({ status: "no_active_turn" }),
    createStream,
  });
}

async function* compactionEvents() {
  const compaction = {
    modelId: "test",
    sequence: 2,
    sessionId: "session_1",
    stepIndex: 0,
    turnId: "turn_1",
  };
  yield* stampTestEvents([
    { type: "compaction.requested", data: { ...compaction, usageInputTokens: 100 } },
    { type: "compaction.completed", data: compaction },
    {
      type: "session.waiting",
      data: { continuationToken: "session_1", wait: "next-user-message" },
    },
  ]);
}

async function* events() {
  yield* stampTestEvents([
    {
      type: "message.completed",
      data: { finishReason: "stop", message: "Done.", sequence: 1, stepIndex: 0, turnId: "turn_1" },
    },
    {
      type: "session.waiting",
      data: { continuationToken: "session_1", wait: "next-user-message" },
    },
  ]);
}

it("warns about unused stubs without failing verification", async () => {
  const { records } = captureLogRecords();
  const client = new Client({ host: "https://eve.test" });
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ sessionId: "session_1" }, { status: 202 }))
    .mockResolvedValueOnce(Response.json({ error: null, matchedRuleIds: ["used"] }));
  const manager = new EvalSessionManager({ client });
  await manager.session({
    stubs: [
      { id: "used", tool: "dynamic_tool", outcome: { response: true } },
      { id: "unused", tool: "connection__operation", outcome: { response: true } },
    ],
  });
  await expect(manager.verifyStubs()).resolves.toBeUndefined();
  expect(records).toContainEqual(
    expect.objectContaining({
      level: "warn",
      message: "Tool stubs did not match any calls: unused.",
    }),
  );
});
