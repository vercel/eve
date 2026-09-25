import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import { MessageResponse } from "#client/message-response.js";
import { ClientSession } from "#client/session.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import { createEvalContext } from "#evals/context.js";
import { EvalSessionManager } from "#evals/session-manager.js";
import { createEvalTargetHandle } from "#evals/target.js";
import { stampTestEvents } from "#internal/testing/events.js";

const mocks = vi.hoisted(() => ({ evaluate: vi.fn() }));

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("#ai/evaluate.js", () => ({ evaluate: mocks.evaluate }));

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
      expect(mocks.evaluate).toHaveBeenCalledWith(
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

    expect(mocks.evaluate).toHaveBeenCalledWith(
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
    expect(mocks.evaluate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ input: "Review Alice's invoice.\nList the line items." }),
      }),
    );

    await session.send([file]);
    context.judge("describes the attachment");
    expect(mocks.evaluate).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: expect.objectContaining({ input: "" }) }),
    );
  });
});

async function setup() {
  mocks.evaluate.mockResolvedValue({
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
  return { context, session: await manager.session() };
}

function response() {
  return new MessageResponse({
    sessionId: "session_1",
    cancelTurn: async () => ({ status: "no_active_turn" }),
    createStream: events,
  });
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
