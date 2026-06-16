import { describe, expect, it } from "vitest";

import { parseBlockActionsPayload } from "#public/channels/slack/interactions.js";

function makePayload(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    actions: [{ action_id: "test_action", value: "test_value" }],
    channel: { id: "C0123456789" },
    message: { ts: "1700000000.000000", thread_ts: "1700000000.000000", blocks: [] },
    team: { id: "T0123456789" },
    user: {
      id: "U0123456789",
      username: "jane.doe",
      name: "jane.doe",
      team_id: "T0123456789",
    },
    ...overrides,
  };
}

describe("parseBlockActionsPayload", () => {
  it("exposes the actor as a nested user object on each parsed action", () => {
    const parsed = parseBlockActionsPayload(
      makePayload({
        actions: [
          { action_id: "approve", value: "v1" },
          { action_id: "dismiss", value: "v2" },
        ],
      }),
    );
    expect(parsed?.actions).toHaveLength(2);
    for (const action of parsed?.actions ?? []) {
      expect(action.user).toEqual({
        id: "U0123456789",
        username: "jane.doe",
        name: "jane.doe",
      });
    }
  });
});
