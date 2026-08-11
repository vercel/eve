import { describe, expect, it } from "vitest";

import {
  slackUserGroupMentions,
  withoutSlackUserGroupMention,
} from "#public/channels/slack/user-groups.js";

describe("slackUserGroupMentions", () => {
  it("returns unique opaque group ids in mention order", () => {
    expect(
      slackUserGroupMentions("Ask <!subteam^S123|preview> then <!subteam^S456>. <!subteam^S123>"),
    ).toEqual([{ id: "S123" }, { id: "S456" }]);
  });
});

describe("withoutSlackUserGroupMention", () => {
  it("removes only the selected group mention", () => {
    expect(
      withoutSlackUserGroupMention("<!subteam^S123|preview> check <!subteam^S456>", "S123"),
    ).toBe("check <!subteam^S456>");
  });
});
