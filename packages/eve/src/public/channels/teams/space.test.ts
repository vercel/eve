import { describe, expect, it } from "vitest";

import { teamsConversationSpace } from "#public/channels/teams/space.js";

const base = { channelId: null, conversationId: null, conversationType: null, tenantId: "t1" };

describe("teamsConversationSpace", () => {
  it("reports a channel conversation's Teams channel, not its thread", () => {
    expect(
      teamsConversationSpace({
        ...base,
        channelId: "19:general@thread.tacv2",
        conversationId: "19:general@thread.tacv2;messageid=1",
        conversationType: "channel",
      }),
    ).toEqual({
      id: "teams:t1:19:general@thread.tacv2",
      type: "channel",
      workspaceId: "teams:t1",
    });
  });

  it("reports personal and group chats by conversation", () => {
    expect(
      teamsConversationSpace({ ...base, conversationId: "a:1", conversationType: "personal" }),
    ).toMatchObject({ id: "teams:t1:a:1", type: "direct", visibility: "private" });
    expect(
      teamsConversationSpace({ ...base, conversationId: "19:g", conversationType: "groupChat" }),
    ).toMatchObject({ id: "teams:t1:19:g", type: "group", visibility: "private" });
  });

  it("reports none without a tenant", () => {
    expect(
      teamsConversationSpace({
        ...base,
        tenantId: null,
        conversationId: "a:1",
        conversationType: "personal",
      }),
    ).toBeUndefined();
  });

  it("reports none for an unknown conversation type", () => {
    expect(
      teamsConversationSpace({ ...base, conversationId: "x", conversationType: "meeting" }),
    ).toBeUndefined();
  });
});
