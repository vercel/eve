import { describe, expect, it } from "vitest";

import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWire as decoder } from "#execution/wire/session-inbox-wire.js";

const command = {
  kind: "send" as const,
  payload: {
    task: {
      agentRequests: [
        {
          replyTo: "agent-reply",
          request: {
            input: {
              history: [{ content: "Prior context", role: "user" as const }],
              message: "Continue researching.",
              target: "research",
            },
            invocationId: "call-1:research",
            kind: "agent-invoke" as const,
          },
          taskId: "task-1",
        },
      ],
    },
  },
  turnPolicy: "queue" as const,
};

describe("session inbox wire v7", () => {
  it("round-trips preloaded workflow subagent history", () => {
    const wire = sessionInboxWire.encode(command, { version: 7 });
    expect(decoder.decode(wire)).toMatchObject({
      kind: "deliver",
      payloads: [command.payload],
    });
  });

  it.each([0, 1, 2, 3, 4, 5, 6] as const)("fails closed for old target v%i", (version) => {
    const target = version === 0 ? ({ variant: "send", version } as const) : ({ version } as const);
    expect(() => sessionInboxWire.encode(command, target)).toThrowError(SessionInboxWireError);
  });
});
