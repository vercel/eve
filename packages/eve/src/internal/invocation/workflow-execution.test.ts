import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunHandle, SessionAuthContext } from "#channel/types.js";
import { INTERNAL_CHANNEL_DELIVER } from "#channel/channel-operations.js";
import {
  buildInvocationAttributes,
  INVOCATION_OWNER_ATTRIBUTE,
  invocationOwnerKey,
  invocationUpdateRequestId,
} from "#internal/invocation/metadata.js";
import { WorkflowAgentInvocationExecution } from "#internal/invocation/workflow-execution.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";

const runsGet = vi.fn();
const cancel = vi.fn();
const returnValue = vi.fn();
const getReadable = vi.fn();

vi.mock("#internal/workflow/runtime.js", () => ({
  getWorld: async () => ({ runs: { get: runsGet } }),
  getRun: () => ({
    cancel,
    get returnValue() {
      return returnValue();
    },
    getReadable,
  }),
}));

const auth: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

const createSession = vi.fn<() => Promise<RunHandle>>();
const deliver = vi.fn();
const from = vi.fn(() => ({ [INTERNAL_CHANNEL_DELIVER]: deliver }) as never);

describe("WorkflowAgentInvocationExecution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getReadable.mockReturnValue(eventStream([]));
  });

  it("seeds invocation metadata when starting a task run", async () => {
    runsGet.mockResolvedValue(run({ status: "running" }));
    createSession.mockResolvedValue({
      events: new ReadableStream(),
      sessionId: "wrun_invocation",
    });
    const invocation = await execution().create({
      auth,
      message: "work",
    });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilities: { requestInput: true },
        externalInvocation: expect.objectContaining({ continuationToken: expect.any(String) }),
        mode: "task",
      }),
    );
    expect(invocation).toMatchObject({
      createdAt: "2026-07-20T00:00:00.000Z",
      invocationId: "wrun_invocation",
      status: "working",
    });
  });

  it("requires the same authenticated principal for invocation access", async () => {
    runsGet.mockResolvedValue(run({ status: "running" }));

    await expect(
      execution().read({
        auth: { ...auth, principalId: "other" },
        invocationId: "wrun_invocation",
      }),
    ).resolves.toBeUndefined();
  });

  it("preserves principal ownership through workflow attribute normalization", async () => {
    const longAuth: SessionAuthContext = {
      attributes: {},
      authenticator: "jwt-ecdsa",
      issuer: `https://login.example/${"tenant".repeat(64)}`,
      principalId: "principal".repeat(64),
      principalType: "user",
      subject: "subject".repeat(64),
    };
    const ownerKey = invocationOwnerKey(longAuth);
    const attributes = normalizeEveAttributes(
      buildInvocationAttributes({ continuationToken: "invocation:token", ownerKey }),
    );
    expect(ownerKey).toHaveLength(64);
    expect(attributes[INVOCATION_OWNER_ATTRIBUTE]).toBe(ownerKey);
    runsGet.mockResolvedValue(run({ ownerKey, status: "running" }));

    await expect(
      execution().read({ auth: longAuth, invocationId: "wrun_invocation" }),
    ).resolves.toMatchObject({ status: "working" });
    await expect(
      execution().read({
        auth: { ...longAuth, subject: `${longAuth.subject}-other` },
        invocationId: "wrun_invocation",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a workflow run without invocation metadata", async () => {
    const otherRun = run({ status: "running" });
    runsGet.mockResolvedValue({ ...otherRun, attributes: {} });

    await expect(
      execution().read({ auth, invocationId: "wrun_invocation" }),
    ).resolves.toBeUndefined();
  });

  it("replays the existing event stream to reconstruct pending input", async () => {
    runsGet.mockResolvedValue(run({ status: "running" }));
    getReadable.mockReturnValue(
      eventStream([
        {
          type: "turn.started",
          data: { turnId: "turn_1" },
          meta: { at: "2026-07-20T00:00:00.000Z", id: "event_1" },
        } as HandleMessageStreamEvent,
        {
          type: "input.requested",
          data: {
            sequence: 0,
            stepIndex: 0,
            turnId: "turn_1",
            requests: [
              {
                action: {
                  callId: "call_1",
                  input: {},
                  kind: "tool-call",
                  toolName: "ask_question",
                },
                kind: "question",
                options: [{ id: "yes", label: "Yes" }],
                prompt: "Proceed?",
                requestId: "question",
              },
            ],
          },
          meta: { at: "2026-07-20T00:00:01.000Z", id: "event_2" },
        } as HandleMessageStreamEvent,
      ]),
    );

    await expect(
      execution().read({ auth, invocationId: "wrun_invocation" }),
    ).resolves.toMatchObject({
      inputRequests: { question: { prompt: "Proceed?" } },
      status: "input_required",
    });
    expect(getReadable).toHaveBeenCalledWith({ startIndex: -64 });
  });

  it("returns working immediately after accepting pending input", async () => {
    runsGet.mockResolvedValue(run({ status: "running" }));
    getReadable.mockReturnValue(
      eventStream([
        {
          type: "input.requested",
          data: {
            sequence: 0,
            stepIndex: 0,
            turnId: "turn_1",
            requests: [
              {
                action: {
                  callId: "call_1",
                  input: {},
                  kind: "tool-call",
                  toolName: "ask_question",
                },
                kind: "question",
                options: [{ id: "yes", label: "Yes" }],
                prompt: "Proceed?",
                requestId: "question",
              },
            ],
          },
          meta: { at: "2026-07-20T00:00:00.000Z", id: "event_1" },
        } as HandleMessageStreamEvent,
      ]),
    );
    deliver.mockResolvedValue({ sessionId: "wrun_invocation" });

    await expect(
      execution().update({
        auth,
        invocationId: "wrun_invocation",
        responses: [{ optionId: "yes", requestId: "question" }],
      }),
    ).resolves.toMatchObject({
      invocation: { pollAfterMs: 1_000, status: "working" },
      type: "success",
    });
    expect(from).toHaveBeenCalledWith("invocation:token");
    expect(deliver).toHaveBeenCalledWith(
      { inputResponses: [{ optionId: "yes", requestId: "question" }] },
      {
        auth,
        requestId: invocationUpdateRequestId([{ optionId: "yes", requestId: "question" }]),
      },
    );
    expect(getReadable).toHaveBeenCalledOnce();
  });

  it("returns the recorded result for a repeated accepted update", async () => {
    const responses = [{ optionId: "yes", requestId: "question" }] as const;
    const receipt = invocationUpdateRequestId(responses).slice("mcp-update:".length);
    runsGet.mockResolvedValue(run({ receipt, status: "running" }));

    await expect(
      execution().update({ auth, invocationId: "wrun_invocation", responses }),
    ).resolves.toMatchObject({ invocation: { status: "working" }, type: "success" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("converges when a concurrent update accepts the same response first", async () => {
    const responses = [{ optionId: "yes", requestId: "question" }] as const;
    const receipt = invocationUpdateRequestId(responses).slice("mcp-update:".length);
    const pendingRun = run({ status: "running" });
    runsGet
      .mockResolvedValueOnce(pendingRun)
      .mockResolvedValueOnce(pendingRun)
      .mockResolvedValueOnce(run({ receipt, status: "running" }));
    getReadable.mockReturnValue(
      eventStream([
        {
          type: "input.requested",
          data: {
            requests: [
              {
                action: {
                  callId: "call_1",
                  input: {},
                  kind: "tool-call",
                  toolName: "ask_question",
                },
                kind: "question",
                prompt: "Proceed?",
                requestId: "question",
              },
            ],
            sequence: 0,
            stepIndex: 0,
            turnId: "turn_1",
          },
          meta: { at: "2026-07-20T00:00:00.000Z", id: "event_1" },
        } as HandleMessageStreamEvent,
      ]),
    );
    deliver.mockRejectedValue(new Error("continuation was already consumed"));

    await expect(
      execution().update({ auth, invocationId: "wrun_invocation", responses }),
    ).resolves.toMatchObject({ invocation: { status: "working" }, type: "success" });
  });

  it("projects and clears pending connection authorization", async () => {
    runsGet.mockResolvedValue(run({ status: "running" }));
    const required = {
      type: "authorization.required",
      data: {
        authorization: {
          displayName: "Linear",
          url: "https://linear.example/authorize",
        },
        description: "Sign in to Linear",
        name: "linear",
        sequence: 0,
        stepIndex: 1,
        turnId: "turn_1",
        webhookUrl: "https://agent.example/connections/linear/callback/token",
      },
      meta: { at: "2026-07-20T00:00:00.000Z", id: "event_1" },
    } as HandleMessageStreamEvent;
    getReadable.mockReturnValue(eventStream([required]));

    await expect(
      execution().read({ auth, invocationId: "wrun_invocation" }),
    ).resolves.toMatchObject({
      authorizations: [
        {
          authorization: {
            displayName: "Linear",
            url: "https://linear.example/authorize",
          },
          description: "Sign in to Linear",
          name: "linear",
        },
      ],
      pollAfterMs: 1_000,
      status: "authorization_required",
    });

    getReadable.mockReturnValue(
      eventStream([
        required,
        {
          type: "authorization.completed",
          data: {
            name: "linear",
            outcome: "authorized",
            sequence: 0,
            stepIndex: 2,
            turnId: "turn_1",
          },
          meta: { at: "2026-07-20T00:00:01.000Z", id: "event_2" },
        } as HandleMessageStreamEvent,
      ]),
    );
    await expect(
      execution().read({ auth, invocationId: "wrun_invocation" }),
    ).resolves.toMatchObject({
      authorizations: undefined,
      status: "working",
    });
  });

  it("does not project intermediate tool-call narration as a result", async () => {
    runsGet.mockResolvedValue(run({ status: "running" }));
    getReadable.mockReturnValue(
      eventStream([
        {
          type: "message.completed",
          data: {
            finishReason: "tool-calls",
            message: "I'll search for that.",
            sequence: 0,
            stepIndex: 0,
            turnId: "turn_1",
          },
          meta: { at: "2026-07-20T00:00:00.000Z", id: "event_1" },
        } as HandleMessageStreamEvent,
      ]),
    );

    const invocation = await execution().read({ auth, invocationId: "wrun_invocation" });

    expect(invocation).toMatchObject({ status: "working" });
    expect(invocation?.result).toBeUndefined();
  });

  it("decodes a final persisted event without a trailing newline", async () => {
    runsGet.mockResolvedValue(run({ status: "running" }));
    getReadable.mockReturnValue(
      eventStream(
        [
          {
            type: "message.completed",
            data: {
              finishReason: "stop",
              message: "Done.",
              sequence: 0,
              stepIndex: 0,
              turnId: "turn_1",
            },
            meta: { at: "2026-07-20T00:00:00.000Z", id: "event_1" },
          } as HandleMessageStreamEvent,
        ],
        { trailingNewline: false },
      ),
    );

    await expect(
      execution().read({ auth, invocationId: "wrun_invocation" }),
    ).resolves.toMatchObject({ result: "Done.", status: "working" });
  });

  it("uses workflow return value as terminal result", async () => {
    runsGet.mockResolvedValue(run({ status: "completed" }));
    getReadable.mockReturnValue(eventStream([{ type: "session.completed" }]));
    returnValue.mockResolvedValue({ output: { answer: 42 } });

    await expect(
      execution().read({ auth, invocationId: "wrun_invocation" }),
    ).resolves.toMatchObject({ result: { answer: 42 }, status: "completed" });
    expect(getReadable).not.toHaveBeenCalled();
  });

  it("terminally cancels the workflow run", async () => {
    runsGet
      .mockResolvedValueOnce(run({ status: "running" }))
      .mockResolvedValueOnce(run({ status: "cancelled" }));
    cancel.mockResolvedValue(undefined);

    await expect(
      execution().cancel({ auth, invocationId: "wrun_invocation" }),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(cancel).toHaveBeenCalledWith();
  });
});

function execution(): WorkflowAgentInvocationExecution {
  return new WorkflowAgentInvocationExecution({ channelName: "mcp", createSession, from });
}

function run(input: { ownerKey?: string; receipt?: string; status: string }) {
  const attributes: Record<string, string> = {
    "$eve.invocation_owner": input.ownerKey ?? invocationOwnerKey(auth),
    "$eve.invocation_token": "invocation:token",
  };
  if (input.receipt !== undefined) attributes["$eve.invocation_update"] = input.receipt;
  return {
    attributes,
    createdAt: new Date("2026-07-20T00:00:00.000Z"),
    input: [{ serializedContext: { "eve.initiatorAuth": auth } }],
    runId: "wrun_invocation",
    status: input.status,
  };
}

function eventStream(
  events: readonly unknown[],
  options: { readonly trailingNewline?: boolean } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = events.map((event, index) => {
    const newline = options.trailingNewline === false && index === events.length - 1 ? "" : "\n";
    return encoder.encode(`${JSON.stringify(event)}${newline}`);
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return Object.assign(stream, { getTailIndex: async () => events.length - 1 });
}
