import { describe, expect, it } from "vitest";

import {
  handleInteractionPost,
  parseBlockActionsPayload,
} from "#public/channels/slack/interactions.js";

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

describe("handleInteractionPost", () => {
  it("acknowledges a view_submission with an empty 200 body so Slack dismisses the modal", async () => {
    const payload = JSON.stringify({
      type: "view_submission",
      view: { callback_id: "some_other_modal" },
    });
    const rawBody = `payload=${encodeURIComponent(payload)}`;
    const ctx = {
      send: async () => undefined,
      waitUntil: () => {},
    } as unknown as Parameters<typeof handleInteractionPost>[1];
    const deps = {} as unknown as Parameters<typeof handleInteractionPost>[2];

    const res = await handleInteractionPost(rawBody, ctx, deps);

    expect(res.status).toBe(200);
    // A non-empty body (e.g. "ok") makes Slack reject the view_submission and
    // leave the modal open; the ack body must be empty to dismiss the modal.
    expect(await res.text()).toBe("");
  });
});
