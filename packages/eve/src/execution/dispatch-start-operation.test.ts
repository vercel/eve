import { describe, expect, it } from "vitest";

import { mintStartOperation } from "#execution/dispatch-start-operation.js";

const VALID = {
  callId: "call_1",
  name: "research",
  nodeId: "node_research",
  parentSessionId: "session_parent",
  parentTurnId: "turn_1",
};

describe("mintStartOperation", () => {
  it("derives deterministically from the same inputs", () => {
    expect(mintStartOperation(VALID)).toEqual(mintStartOperation(VALID));
  });

  it.each(["callId", "parentSessionId", "parentTurnId"] as const)(
    "throws at mint time when %s is empty instead of corrupting the handle store at persist time",
    (field) => {
      expect(() => mintStartOperation({ ...VALID, [field]: "" })).toThrow(field);
    },
  );
});
