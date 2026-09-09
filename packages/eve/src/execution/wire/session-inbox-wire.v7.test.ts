import { describe, expect, it } from "vitest";

import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWire as decoder } from "#execution/wire/session-inbox-wire.js";

const command = {
  kind: "append-history" as const,
  messages: [{ content: "Approved", role: "assistant" as const }],
  operationId: "research:approved",
  replyTo: "ack-hook",
};

describe("session inbox wire v7", () => {
  it("round-trips acknowledged history append", () => {
    const wire = sessionInboxWire.encode(command, { version: 7 });
    expect(decoder.decode(wire)).toEqual(command);
  });

  it.each([0, 1, 2, 3, 4, 5, 6] as const)("fails closed for old target v%i", (version) => {
    const target = version === 0 ? ({ variant: "send", version } as const) : ({ version } as const);
    expect(() => sessionInboxWire.encode(command, target)).toThrowError(SessionInboxWireError);
  });
});
