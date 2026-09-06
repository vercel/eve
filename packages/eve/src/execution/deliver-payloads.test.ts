import { describe, expect, it } from "vitest";
import type { DeliverHookPayload } from "#channel/types.js";
import {
  bufferObservedDelivery,
  coalesceDeliverPayloads,
  hasAddressedDelivery,
  isObserveOnlyDelivery,
} from "#execution/deliver-payloads.js";

const FIRST_MESSAGE = "Please summarize the synthetic release checklist before the rollout.";
const SECOND_MESSAGE = "Proceed after the synthetic health check passes.";
const FIRST_CALLBACK_CONTEXT = "Release policy: use the synthetic staging environment only.";
const SECOND_CALLBACK_CONTEXT = "Release policy: wait for the synthetic health check.";

describe("coalesceDeliverPayloads", () => {
  it("preserves messages and authored callback context in arrival order", () => {
    const result = coalesceDeliverPayloads([
      {
        context: [FIRST_CALLBACK_CONTEXT],
        message: FIRST_MESSAGE,
      },
      {
        context: [SECOND_CALLBACK_CONTEXT],
        message: SECOND_MESSAGE,
      },
    ]);

    expect(result).toEqual({
      context: [FIRST_CALLBACK_CONTEXT, SECOND_CALLBACK_CONTEXT],
      message: `${FIRST_MESSAGE}\n\n${SECOND_MESSAGE}`,
    });
  });

  it("omits blank messages after preserving adapter fields", () => {
    const result = coalesceDeliverPayloads([
      { adapterMetadata: { deliverySequence: 1 }, message: " " },
      { message: "\n" },
    ]);

    expect(result).toEqual({ adapterMetadata: { deliverySequence: 1 } });
  });

  it("preserves queued input responses and adapter fields", () => {
    const result = coalesceDeliverPayloads([
      {
        adapterMetadata: { callbackKind: "button", deliverySequence: 1 },
        inputResponses: [{ optionId: "approve", requestId: "approval_synthetic_release" }],
        preservedAdapterMetadata: { source: "synthetic-callback" },
      },
      {
        adapterMetadata: { callbackKind: "message", deliverySequence: 2 },
        inputResponses: [
          { requestId: "question_synthetic_rollout", text: "Begin with the synthetic canary." },
        ],
        nextAdapterMetadata: { callbackVersion: 2 },
        preservedAdapterMetadata: undefined,
      },
    ]);

    expect(result).toEqual({
      adapterMetadata: { callbackKind: "message", deliverySequence: 2 },
      inputResponses: [
        { optionId: "approve", requestId: "approval_synthetic_release" },
        { requestId: "question_synthetic_rollout", text: "Begin with the synthetic canary." },
      ],
      nextAdapterMetadata: { callbackVersion: 2 },
      preservedAdapterMetadata: { source: "synthetic-callback" },
    });
  });

  it("keeps observe only when every payload was observed", () => {
    expect(
      coalesceDeliverPayloads([
        { message: "U1: had a rough week", observe: true },
        { message: "U2: same here", observe: true },
      ]),
    ).toEqual({ message: "U1: had a rough week\n\nU2: same here", observe: true });

    expect(
      coalesceDeliverPayloads([
        { message: "U1: had a rough week", observe: true },
        { message: "@bot what do you think?" },
      ]),
    ).toEqual({ message: "U1: had a rough week\n\n@bot what do you think?" });
  });

  it("preserves task agent requests and authorization events across queued payloads", () => {
    const agentRequests = [
      {
        replyTo: "agent-reply-1",
        request: {
          input: { message: "Find it", target: "first" },
          invocationId: "call-1:first",
          kind: "agent-invoke" as const,
        },
        taskId: "task-1",
      },
      {
        replyTo: "agent-reply-2",
        request: {
          input: { message: "Find it", target: "second" },
          invocationId: "call-2:second",
          kind: "agent-invoke" as const,
        },
        taskId: "task-2",
      },
    ];
    const authorizationEvents = [1, 2].map((index) => ({
      hookPayload: {
        callId: `call-${index}`,
        childSessionId: `child-${index}`,
        event: { data: { index }, type: "authorization.required" } as never,
        kind: "subagent-authorization-event" as const,
        subagentName: `agent-${index}`,
      },
      taskId: `task-${index}`,
    }));

    expect(
      coalesceDeliverPayloads([
        {
          task: {
            agentRequests: [agentRequests[0]!],
            authorizationEvents: [authorizationEvents[0]!],
          },
        },
        {
          task: {
            agentRequests: [agentRequests[1]!],
            authorizationEvents: [authorizationEvents[1]!],
          },
        },
      ]),
    ).toEqual({ task: { agentRequests, authorizationEvents } });
  });
});

describe("bufferObservedDelivery", () => {
  function observed(message: string): DeliverHookPayload {
    return { kind: "deliver", payloads: [{ message, observe: true }] };
  }

  it("buffers observe-only deliveries and leaves addressed ones to the caller", () => {
    const buffer: DeliverHookPayload[] = [];
    const addressed: DeliverHookPayload = { kind: "deliver", payloads: [{ message: "@bot hi" }] };

    expect(bufferObservedDelivery(buffer, observed("aside"))).toBe(true);
    expect(bufferObservedDelivery(buffer, addressed)).toBe(false);

    expect(buffer).toEqual([observed("aside")]);
    expect(isObserveOnlyDelivery(observed("aside"))).toBe(true);
    expect(isObserveOnlyDelivery(addressed)).toBe(false);
    expect(hasAddressedDelivery(buffer)).toBe(false);
    expect(hasAddressedDelivery([...buffer, addressed])).toBe(true);
  });

  it("drops the oldest observed deliveries past the buffer limit", () => {
    const buffer: DeliverHookPayload[] = [
      { kind: "deliver", payloads: [{ inputResponses: [{ optionId: "yes", requestId: "r1" }] }] },
    ];
    for (let index = 0; index < 257; index += 1) {
      bufferObservedDelivery(buffer, observed(`message ${index}`));
    }

    expect(buffer).toHaveLength(257);
    expect(buffer[0]?.payloads[0]?.inputResponses).toBeDefined();
    expect(buffer[1]).toEqual(observed("message 1"));
    expect(buffer.at(-1)).toEqual(observed("message 256"));
  });
});
