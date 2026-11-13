import type { SlackThread } from "eve/channels/slack";
import { beforeEach, describe, expect, it, vi } from "vitest";

import publishTool from "../../tools/publish_contentful_entry";
import { createInputRequestEvents } from "../integrations/slack/input-requests";
import type { SlackInputRequest } from "../integrations/slack/input-requests";
import { approvalContext, toolContext } from "../testing/session";
import { slackEventContext } from "../testing/slack";
import { installTestState, testState } from "../testing/state";
import { isCallable } from "../values";
import { contentfulPublicationInput } from "./publication-input";
import { createCmaFake, link } from "./testing/cma";

const input = {
  entries: [{ entryId: "entry", expectedVersion: 7 }],
  space: "docs",
};
const policy = publishTool.approval;
if (!policy || !("request" in policy) || !isCallable(policy.request)) {
  throw new Error("Publication requires a request policy.");
}
const { request } = policy;
const metadata = { sequence: 1, stepIndex: 0, turnId: "turn-1" };
const approval: SlackInputRequest = {
  action: {
    callId: "call-1",
    input,
    kind: "tool-call",
    toolName: "publish_contentful_entry",
  },
  kind: "tool-approval",
  options: [
    { id: "approve", label: "Approve", style: "primary" },
    { id: "cancel", label: "Cancel" },
  ],
  prompt: "Approve publication?",
  requestId: "approval-1",
};
const seed = () =>
  createCmaFake({
    entries: [
      {
        fields: { title: { "en-US": "Example entry" } },
        sys: {
          contentType: link("guide", "ContentType"),
          id: "entry",
          version: 7,
        },
      },
    ],
  });
const deliver = (post: SlackThread["post"]) => {
  const channel = slackEventContext({ thread: { post } });
  return {
    channel,
    run: () =>
      createInputRequestEvents(contentfulPublicationInput)["input.requested"](
        { ...metadata, requests: [approval] },
        channel
      ),
  };
};

beforeEach(() => testState.reset());

describe("publication card delivery", () => {
  it("lists the saved scope and unlocks publication only after confirmed delivery", async () => {
    const cma = seed();
    expect(await request(approvalContext(input))).toBe("user-approval");
    await expect(publishTool.execute(input, toolContext())).rejects.toThrow(
      "not been shown"
    );

    const post = vi.fn<SlackThread["post"]>(
      async () => await { id: "card-ts", raw: { ok: true } }
    );
    const { channel, run } = deliver(post);
    await run();

    expect(post).toHaveBeenCalledOnce();
    const card = post.mock.calls[0]?.[0];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("Example entry");
    expect(serialized).toContain(
      '"action_id":"eve_input:tool-approval:approval-1:button:0"'
    );
    expect(serialized).toContain('"text":"Publish"');
    expect(channel.state.pendingApprovalCards?.["approval-1"]?.messageTs).toBe(
      "card-ts"
    );
    expect(cma.writes()).toHaveLength(0);

    expect(await publishTool.execute(input, toolContext())).toMatchObject({
      complete: true,
    });
    expect(cma.writes()).toHaveLength(1);
  });

  it.each([
    { id: "", raw: { ok: true } },
    { id: "card-ts", raw: { ok: false } },
  ])(
    "keeps publication blocked after unconfirmed delivery %j",
    async (result) => {
      const cma = seed();
      expect(await request(approvalContext(input))).toBe("user-approval");
      const post = vi.fn<SlackThread["post"]>(async () => await result);
      const { channel, run } = deliver(post);

      await expect(run()).rejects.toThrow("Could not confirm delivery");
      expect(post).toHaveBeenCalledOnce();
      expect(channel.state.pendingApprovalCards).toBeUndefined();
      await expect(publishTool.execute(input, toolContext())).rejects.toThrow(
        "not been shown"
      );
      expect(cma.writes()).toHaveLength(0);
    }
  );
});

beforeEach(installTestState);
