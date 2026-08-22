import { describe, expect, it, vi } from "vitest";

import { createChannelOperations, type ChannelSource } from "#channel/channel-operations.js";
import type { Runtime } from "#channel/types.js";
import { type InputResponse, parseInputResponses } from "#runtime/input/types.js";

function authoredChannelRespondTypeChecks(source: ChannelSource): void {
  const responseWithMetadata = {
    kind: "tool-approval",
    optionId: "approve",
    requestId: "approval-1",
  } as const;
  const responsesWithMetadata = [responseWithMetadata] as const;

  // @ts-expect-error channel-local metadata is not part of the input-response contract.
  void source.respond([responseWithMetadata], { auth: null });
  // @ts-expect-error exactness must survive a preassembled response array.
  void source.respond(responsesWithMetadata, { auth: null });

  const widenedResponses: readonly InputResponse[] = responsesWithMetadata;
  // @ts-expect-error widened responses must be schema-validated before delivery.
  void source.respond(widenedResponses, { auth: null });

  const validatedResponses = parseInputResponses([
    { optionId: "approve", requestId: "approval-1" },
  ]);
  void source.respond(validatedResponses, { auth: null });
}

void authoredChannelRespondTypeChecks;

function createRuntime(): Runtime {
  return {
    createSession: vi.fn(),
    dispatchContinuation: vi.fn().mockResolvedValue({
      sessionId: "sess_1",
      status: "accepted",
    }),
    dispatchSession: vi.fn(),
    getEventStream: vi.fn(),
    getStreamTailIndex: vi.fn(),
    resolveContinuation: vi.fn(),
  };
}

describe("createChannelOperations", () => {
  it("sends through a channel-local address without serializing operation options", async () => {
    const runtime = createRuntime();
    const { from } = createChannelOperations({
      adapter: { kind: "slack" },
      channelName: "slack",
      runtime,
    });

    const session = await from("C1:T1").send("hello", {
      auth: null,
      title: "Support thread",
    });
    await session.clear();

    expect(runtime.dispatchContinuation).toHaveBeenCalledWith({
      command: {
        auth: null,
        kind: "send",
        payload: { message: "hello" },
        requestId: undefined,
        turnPolicy: "steer",
      },
      continuationToken: "slack:C1:T1",
    });
    expect(runtime.dispatchSession).toHaveBeenCalledWith({
      command: { kind: "clear" },
      sessionId: "sess_1",
    });
  });

  it("carries an input-response state patch through the durable delivery", async () => {
    const runtime = createRuntime();
    const { from } = createChannelOperations<{ responder: string }>({
      adapter: { kind: "slack" },
      channelName: "slack",
      runtime,
    });

    await from("C1:T1").respond([{ optionId: "approve", requestId: "approval-1" }], {
      auth: null,
      state: { responder: "U_APPROVER" },
    });

    expect(runtime.dispatchContinuation).toHaveBeenCalledWith({
      command: {
        auth: null,
        kind: "send",
        payload: {
          inputResponses: [{ optionId: "approve", requestId: "approval-1" }],
          state: { responder: "U_APPROVER" },
        },
        requestId: undefined,
        turnPolicy: undefined,
      },
      continuationToken: "slack:C1:T1",
    });
  });

  it("targets every control operation by raw channel-local address", async () => {
    const runtime = createRuntime();
    const { from } = createChannelOperations({
      adapter: { kind: "slack" },
      channelName: "slack",
      runtime,
    });

    const source = from("C1:T1");
    await source.cancel({ turnId: "turn_1" });
    await source.compact();
    await source.clear();
    await source.reset({ reason: "fresh start" });

    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(1, {
      command: { kind: "cancel", turnId: "turn_1" },
      continuationToken: "slack:C1:T1",
    });
    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(2, {
      command: { kind: "compact" },
      continuationToken: "slack:C1:T1",
    });
    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(3, {
      command: { kind: "clear" },
      continuationToken: "slack:C1:T1",
    });
    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(4, {
      command: { kind: "reset", reason: "fresh start" },
      continuationToken: "slack:C1:T1",
    });
  });

  it("resolves an address owner only when explicitly requested", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.resolveContinuation).mockResolvedValue({ sessionId: "sess_2" });
    const { resolveSession } = createChannelOperations({
      adapter: { kind: "slack" },
      channelName: "slack",
      runtime,
    });

    const session = await resolveSession("C1:T1");
    await session?.clear();

    expect(runtime.resolveContinuation).toHaveBeenCalledWith("slack:C1:T1");
    expect(runtime.dispatchSession).toHaveBeenCalledWith({
      command: { kind: "clear" },
      sessionId: "sess_2",
    });
  });
});
