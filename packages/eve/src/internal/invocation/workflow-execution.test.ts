import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunHandle, SessionAuthContext } from "#channel/types.js";
import { INTERNAL_CHANNEL_DELIVER } from "#channel/channel-operations.js";
import {
  buildInvocationAttributes,
  INVOCATION_OWNER_ATTRIBUTE,
  invocationInputRequestId,
  invocationOwnerKey,
  invocationUpdateRequestId,
} from "#internal/invocation/metadata.js";
import {
  INVOCATION_UPDATE_RECEIPT_ATTRIBUTE,
  invocationUpdateIdentityFromRequestId,
  serializeInvocationUpdateIdentity,
} from "#internal/invocation/attributes.js";
import type { InvocationUpdateIdentity } from "#internal/invocation/attributes.js";
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

    const requestId = invocationInputRequestId("event_2", "question");
    await expect(
      execution().read({ auth, invocationId: "wrun_invocation" }),
    ).resolves.toMatchObject({
      inputRequests: { [requestId]: { prompt: "Proceed?", requestId } },
      status: "input_required",
    });
    expect(getReadable).toHaveBeenCalledWith({ startIndex: -64 });
  });

  it("returns working immediately after accepting pending input", async () => {
    const requestId = invocationInputRequestId("event_1", "question");
    const responses = [{ optionId: "yes", requestId }] as const;
    const pendingRun = run({ status: "running" });
    runsGet.mockResolvedValue(pendingRun);
    let events: HandleMessageStreamEvent[] = [
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
    ];
    getReadable.mockImplementation(() => eventStream(events));
    deliver.mockImplementation(async () => {
      const update = invocationUpdateIdentityFromRequestId(
        invocationUpdateRequestId(responses, "event_1"),
      )!;
      pendingRun.attributes[INVOCATION_UPDATE_RECEIPT_ATTRIBUTE] =
        serializeInvocationUpdateIdentity(update);
      return { sessionId: "wrun_invocation" };
    });

    await expect(
      execution().update({
        auth,
        invocationId: "wrun_invocation",
        responses,
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
        requestId: invocationUpdateRequestId(responses, "event_1"),
      },
    );
    expect(getReadable).toHaveBeenCalledWith({ startIndex: -64 });
  });

  it("returns the recorded result for a repeated accepted update", async () => {
    const responses = [{ optionId: "yes", requestId: "question" }] as const;
    const update = invocationUpdateIdentityFromRequestId(
      invocationUpdateRequestId(responses, "event_1"),
    )!;
    runsGet.mockResolvedValue(run({ status: "running", update }));
    getReadable.mockReturnValue(eventStream([]));

    await expect(
      execution().update({ auth, invocationId: "wrun_invocation", responses }),
    ).resolves.toMatchObject({ invocation: { status: "working" }, type: "success" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("rejects a different answer after the pending input set was claimed", async () => {
    const accepted = [{ optionId: "yes", requestId: "question" }] as const;
    const attempted = [{ optionId: "no", requestId: "question" }] as const;
    const acceptedUpdate = invocationUpdateIdentityFromRequestId(
      invocationUpdateRequestId(accepted, "event_1"),
    )!;
    runsGet.mockResolvedValue(run({ status: "running", update: acceptedUpdate }));
    getReadable.mockReturnValue(eventStream([]));

    await expect(
      execution().update({ auth, invocationId: "wrun_invocation", responses: attempted }),
    ).resolves.toEqual({
      message: "Input was already answered with a different response.",
      type: "conflict",
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("converges when a concurrent update accepts the same response first", async () => {
    const responses = [
      { optionId: "yes", requestId: invocationInputRequestId("event_1", "question") },
    ] as const;
    const update = invocationUpdateIdentityFromRequestId(
      invocationUpdateRequestId(responses, "event_1"),
    )!;
    const pendingRun = run({ status: "running" });
    runsGet.mockResolvedValue(pendingRun);
    let events: HandleMessageStreamEvent[] = [
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
    ];
    getReadable.mockImplementation(() => eventStream(events));
    deliver.mockImplementation(async () => {
      pendingRun.attributes[INVOCATION_UPDATE_RECEIPT_ATTRIBUTE] =
        serializeInvocationUpdateIdentity(update);
      throw new Error("continuation was already consumed");
    });

    await expect(
      execution().update({ auth, invocationId: "wrun_invocation", responses }),
    ).resolves.toMatchObject({ invocation: { status: "working" }, type: "success" });
  });

  it("requires one update to answer the complete pending input batch", async () => {
    const pendingRun = run({ status: "running" });
    runsGet.mockResolvedValue(pendingRun);
    getReadable.mockImplementation(() =>
      eventStream([inputRequestedEvent("event_split", ["one", "two"])]),
    );
    deliver.mockImplementation(async (_payload, options) => {
      const update = invocationUpdateIdentityFromRequestId(options.requestId)!;
      pendingRun.attributes[INVOCATION_UPDATE_RECEIPT_ATTRIBUTE] =
        serializeInvocationUpdateIdentity(update);
      return { sessionId: "wrun_invocation" };
    });

    const one = invocationInputRequestId("event_split", "one");
    const two = invocationInputRequestId("event_split", "two");
    await expect(
      execution().update({
        auth,
        invocationId: "wrun_invocation",
        responses: [{ optionId: "yes", requestId: one }],
      }),
    ).resolves.toEqual({
      message: "Responses must answer the complete pending input batch exactly once.",
      type: "conflict",
    });
    await expect(
      execution().update({
        auth,
        invocationId: "wrun_invocation",
        responses: [
          { optionId: "yes", requestId: one },
          { optionId: "yes", requestId: two },
        ],
      }),
    ).resolves.toMatchObject({ type: "success" });
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      {
        inputResponses: [
          { optionId: "yes", requestId: "one" },
          { optionId: "yes", requestId: "two" },
        ],
      },
      expect.objectContaining({ auth }),
    );
  });

  it("rejects delayed retries when a later batch reuses an internal request id", async () => {
    const pendingRun = run({ status: "running" });
    runsGet.mockResolvedValue(pendingRun);
    let events: HandleMessageStreamEvent[] = [inputRequestedEvent("event_first", ["question"])];
    getReadable.mockImplementation(() => eventStream(events));
    deliver.mockImplementation(async (_payload, options) => {
      const update = invocationUpdateIdentityFromRequestId(options.requestId)!;
      pendingRun.attributes[INVOCATION_UPDATE_RECEIPT_ATTRIBUTE] =
        serializeInvocationUpdateIdentity(update);
      return { sessionId: "wrun_invocation" };
    });

    const firstRequestId = invocationInputRequestId("event_first", "question");
    await execution().update({
      auth,
      invocationId: "wrun_invocation",
      responses: [{ optionId: "yes", requestId: firstRequestId }],
    });
    events = [
      {
        data: { sequence: 1, turnId: "turn_2" },
        meta: { at: "2026-07-20T00:00:01.000Z", id: "event_turn" },
        type: "turn.started",
      },
      inputRequestedEvent("event_second", ["question"]),
    ];
    await expect(
      execution().update({
        auth,
        invocationId: "wrun_invocation",
        responses: [{ optionId: "yes", requestId: firstRequestId }],
      }),
    ).resolves.toEqual({
      message: `Unknown input request: ${firstRequestId}`,
      type: "conflict",
    });

    const secondRequestId = invocationInputRequestId("event_second", "question");
    await expect(
      execution().update({
        auth,
        invocationId: "wrun_invocation",
        responses: [{ optionId: "no", requestId: secondRequestId }],
      }),
    ).resolves.toMatchObject({ type: "success" });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0]?.[1].requestId).not.toBe(deliver.mock.calls[1]?.[1].requestId);
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

function run(input: { ownerKey?: string; status: string; update?: InvocationUpdateIdentity }) {
  const attributes: Record<string, string> = {
    "$eve.invocation_owner": input.ownerKey ?? invocationOwnerKey(auth),
    "$eve.invocation_token": "invocation:token",
  };
  if (input.update !== undefined) {
    attributes[INVOCATION_UPDATE_RECEIPT_ATTRIBUTE] = serializeInvocationUpdateIdentity(
      input.update,
    );
  }
  return {
    attributes,
    createdAt: new Date("2026-07-20T00:00:00.000Z"),
    input: [{ serializedContext: { "eve.initiatorAuth": auth } }],
    runId: "wrun_invocation",
    status: input.status,
  };
}

function inputRequestedEvent(id: string, requestIds: readonly string[]): HandleMessageStreamEvent {
  return {
    data: {
      requests: requestIds.map((requestId) => ({
        action: {
          callId: requestId,
          input: {},
          kind: "tool-call" as const,
          toolName: "ask_question",
        },
        kind: "question" as const,
        prompt: `Answer ${requestId}`,
        requestId,
      })),
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_1",
    },
    meta: { at: "2026-07-20T00:00:00.000Z", id },
    type: "input.requested",
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
