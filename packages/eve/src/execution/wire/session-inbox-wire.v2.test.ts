import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";

import { sessionInboxWire as sessionInboxWireEncoder } from "#execution/wire/session-inbox-encoder.js";
import { sessionInboxWire as sessionInboxWireDecoder } from "#execution/wire/session-inbox-wire.js";
import { sessionInboxWireV2Schema } from "#execution/wire/session-inbox-wire.v2.js";

const activityObserver = {
  sink: { url: "https://example.com/eve/v1/activity/opaque-token", version: 1 as const },
  workIdentity: {
    callId: "call-1",
    id: "work:call-1",
    kind: "subagent" as const,
    name: "researcher",
    rootSessionId: "root",
    rootTurnId: "turn",
  },
};
const caller = {
  activityObserver,
  callId: "call-1",
  replyTo: {
    kind: "callback" as const,
    token: "callback-token",
    url: "https://example.com/callback",
  },
  subagentName: "researcher",
};

describe("session inbox wire v2", () => {
  it("preserves activity observers for v2 consumers", () => {
    const wire = sessionInboxWireEncoder.encode(
      { caller, kind: "send", payload: { message: "observe" } },
      { version: 2 },
    );

    expect(wire).toMatchObject({ caller, version: 2 });
    expect(sessionInboxWireDecoder.decode(JSON.parse(JSON.stringify(wire)))).toMatchObject({
      caller,
      kind: "deliver",
      payloads: [{ message: "observe" }],
    });
  });

  it("round-trips task deliveries with activity observers", () => {
    const task = {
      views: [
        {
          metadata: {
            agentId: "agent-1",
            kind: "subagent" as const,
            mode: "local" as const,
            name: "researcher",
          },
          status: "working" as const,
          taskId: "task-1",
        },
      ],
    };
    const wire = sessionInboxWireEncoder.encode(
      { caller, kind: "deliver", payloads: [{ task }] },
      { version: 2 },
    );

    expect(sessionInboxWireDecoder.decode(JSON.parse(JSON.stringify(wire)))).toMatchObject({
      caller,
      kind: "deliver",
      payloads: [{ task }],
    });
  });

  it("normalizes omitted task values to their JSON wire representation", () => {
    const payload = {
      task: {
        inputRequests: [
          {
            hookPayload: {
              callId: "call-1",
              childContinuationToken: "continue-1",
              childSessionId: "child-1",
              event: {
                requests: [
                  {
                    action: {
                      callId: "tool-1",
                      input: { marker: "FIRST", omitted: undefined },
                      kind: "tool-call",
                      toolName: "first_gate",
                    },
                    kind: "tool-approval",
                    prompt: "Approve first_gate?",
                    requestId: "request-1",
                  },
                ],
                sequence: 1,
                stepIndex: 0,
                turnId: "turn-1",
              },
              kind: "subagent-input-request",
              subagentName: "researcher",
            },
            taskId: "task-1",
          },
        ],
        views: [
          {
            lastOutput: { data: { omitted: undefined, status: "done" }, type: "result" },
            metadata: { kind: "tool", name: "export" },
            status: "completed",
            taskId: "task-2",
          },
        ],
      },
    };
    const wire = sessionInboxWireEncoder.encode({ kind: "send", payload } as never, { version: 2 });

    const expected = {
      payloads: [
        {
          task: {
            inputRequests: [
              {
                hookPayload: {
                  event: { requests: [{ action: { input: { marker: "FIRST" } } }] },
                },
              },
            ],
            views: [{ lastOutput: { data: { status: "done" } } }],
          },
        },
      ],
    };
    expect(wire).toMatchObject(expected);
    expect(sessionInboxWireDecoder.decode(wire)).toMatchObject(expected);
  });

  it("normalizes plain records received from another VM realm", () => {
    const data = runInNewContext(
      `({ address: { sessionRef: "child" }, identity: { id: "agent" } })`,
    );
    const wire = sessionInboxWireEncoder.encode(
      {
        kind: "send",
        payload: {
          task: {
            views: [
              {
                executor: { binding: { data, kind: "subagent" } },
                metadata: { kind: "subagent", name: "worker" },
                status: "working",
                taskId: "task-1",
              },
            ],
          },
        },
      } as never,
      { version: 2 },
    );

    expect(sessionInboxWireDecoder.decode(wire)).toMatchObject({
      payloads: [
        {
          task: {
            views: [
              {
                executor: {
                  binding: {
                    data: { address: { sessionRef: "child" }, identity: { id: "agent" } },
                  },
                },
              },
            ],
          },
        },
      ],
    });
  });

  it("omits activity observers for v1 consumers", () => {
    const wire = sessionInboxWireEncoder.encode(
      { caller, kind: "send", payload: { message: "legacy" } },
      { version: 1 },
    );

    expect(wire).toMatchObject({
      caller: {
        callId: "call-1",
        replyTo: caller.replyTo,
        subagentName: "researcher",
      },
      version: 1,
    });
    expect(wire).not.toHaveProperty("caller.activityObserver");
  });

  it("migrates frozen v1 deliveries before decoding", () => {
    expect(
      sessionInboxWireDecoder.decode({
        caller: {
          callId: "call-1",
          replyTo: caller.replyTo,
          subagentName: "researcher",
        },
        kind: "deliver",
        payloads: [{ message: "legacy" }],
        version: 1,
      }),
    ).toMatchObject({
      caller: {
        callId: "call-1",
        replyTo: caller.replyTo,
        subagentName: "researcher",
      },
      kind: "deliver",
      payloads: [{ message: "legacy" }],
    });
  });

  it("pins the complete schema byte for byte", () => {
    expect(
      stableStringify(
        z.toJSONSchema(sessionInboxWireV2Schema, { io: "input", unrepresentable: "any" }),
      ),
    ).toMatchSnapshot();
  });
});

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
    );
  });
}
