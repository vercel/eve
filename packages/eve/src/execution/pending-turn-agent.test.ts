import { describe, expect, it } from "vitest";

import { PendingTurnAgentNodeIdKey } from "#context/keys.js";
import { inheritPendingTurnAgent } from "#execution/pending-turn-agent.js";

describe("inheritPendingTurnAgent", () => {
  const pendingContext = { [PendingTurnAgentNodeIdKey.name]: "node:researcher" };

  it("resumes the selected agent for input responses", () => {
    expect(
      inheritPendingTurnAgent(
        {
          kind: "deliver",
          payloads: [{ inputResponses: [{ optionId: "approve", requestId: "req-1" }] }],
        },
        pendingContext,
      ),
    ).toMatchObject({ agentNodeId: "node:researcher" });
  });

  it("does not apply a pending selector to a new user message", () => {
    const delivery = { kind: "deliver" as const, payloads: [{ message: "new turn" }] };
    expect(inheritPendingTurnAgent(delivery, pendingContext)).toBe(delivery);
  });
});
