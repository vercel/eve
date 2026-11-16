import type { SlackThread } from "eve/channels/slack";
import type { Interaction } from "eve/events";
import { beforeEach, describe, expect, it, vi } from "vitest";

import publishTool from "../../tools/publish_contentful_entry";
import { createInteractionRenderer } from "../integrations/slack/interactions";
import { approvalContext, toolContext } from "../testing/session";
import { slackEventContext, interactionOpenedHarness } from "../testing/slack";
import { installTestState, testState } from "../testing/state";
import { isCallable } from "../values";
import { contentfulPublicationInteractions } from "./publication-input";
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
const approval: Interaction = {
  call: { callId: "call-1", input, name: "publish_contentful_entry" },
  interactionId: "approval-1",
  request: { kind: "approval", prompt: "Approve publication?" },
  status: "open",
  stepIndex: 0,
  turnId: "turn-1",
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
  const handler = createInteractionRenderer(contentfulPublicationInteractions)
    .events?.["interaction.opened"];
  if (!handler) {
    throw new Error("Expected publication preview delivery handler.");
  }
  const channel = slackEventContext({ thread: { post } });
  return {
    channel,
    run: () => interactionOpenedHarness(approval, channel).run(handler),
  };
};

beforeEach(() => testState.reset());

describe("publication card delivery", () => {
  it("denies delegated page publication but permits an explicit component-only batch", async () => {
    const cma = seed();
    const ctx = approvalContext(input);
    const delegated = {
      ...ctx,
      session: {
        ...ctx.session,
        parent: {
          callId: "parent-call",
          rootSessionId: "root-session",
          sessionId: "parent-session",
          turn: { id: "parent-turn", sequence: 1 },
        },
      },
    };
    expect(await request(delegated)).toMatchObject({
      reason: expect.stringContaining("main conversation"),
      type: "denied",
    });
    const entry = cma.entries.get("entry");
    if (!entry) {
      throw new Error("Expected the seeded entry.");
    }
    entry.sys.contentType = link("codeBlock", "ContentType");
    testState.reset();
    expect(await request(delegated)).toBe("not-applicable");
    expect(cma.writes()).toHaveLength(0);
  });
  it("lists the saved scope and unlocks publication only after confirmed delivery", async () => {
    const cma = seed();
    expect(await request(approvalContext(input))).toBe("user-approval");
    await expect(publishTool.execute(input, toolContext())).rejects.toThrow(
      "not been shown"
    );

    const post = vi.fn<SlackThread["post"]>(
      async () => await { id: "card-ts", raw: { ok: true } }
    );
    const { run } = deliver(post);
    await run();

    expect(post).toHaveBeenCalledOnce();
    const card = post.mock.calls[0]?.[0];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("Example entry");
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
      const { run } = deliver(post);

      await expect(run()).rejects.toThrow("Could not confirm delivery");
      expect(post).toHaveBeenCalledOnce();
      await expect(publishTool.execute(input, toolContext())).rejects.toThrow(
        "not been shown"
      );
      expect(cma.writes()).toHaveLength(0);
    }
  );
});

beforeEach(installTestState);
