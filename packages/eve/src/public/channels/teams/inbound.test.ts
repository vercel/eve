import { describe, expect, it } from "vitest";

import {
  formatTeamsContextBlock,
  parseTeamsActivity,
  teamsThreadRootActivityId,
} from "#public/channels/teams/inbound.js";

describe("Teams inbound parsing", () => {
  it("parses personal message activities", () => {
    const activity = parseTeamsActivity(messageActivity({ conversationType: "personal" }));
    expect(activity).toMatchObject({
      scope: "personal",
      text: "hello",
      type: "message",
    });
    expect(activity?.type === "message" ? teamsThreadRootActivityId(activity) : "bad").toBeNull();
  });

  it("strips direct bot mentions in channel messages", () => {
    const activity = parseTeamsActivity(
      messageActivity({
        conversationType: "channel",
        text: "<at>eve Bot</at> <b>status</b><br>please",
      }),
    );
    expect(activity).toMatchObject({
      isBotMentioned: true,
      scope: "channel",
      text: "**status**\nplease",
      type: "message",
    });
    expect(activity?.type === "message" ? teamsThreadRootActivityId(activity) : "bad").toBe(
      "ACTIVITY_1",
    );
  });

  it("keeps ambient RSC messages parseable but unmentioned", () => {
    const raw = messageActivity({ conversationType: "groupChat", text: "ambient" });
    raw.entities = [];
    const activity = parseTeamsActivity(raw);
    expect(activity).toMatchObject({
      isBotMentioned: false,
      scope: "groupChat",
      text: "ambient",
    });
  });

  it("renders deterministic Teams context", () => {
    const block = formatTeamsContextBlock({
      activityId: "A1",
      channelId: "CH1",
      conversationId: "C1",
      scope: "channel",
      teamId: "TEAM",
      tenantId: "TENANT",
      userId: "U1",
      userName: "Ada",
    });
    expect(block).toContain("<teams_context>");
    expect(block).toContain("response_medium: microsoft_teams");
    expect(block).toContain("user_id: U1");
  });
});

function messageActivity(input: {
  readonly conversationType: string;
  readonly text?: string;
}): Record<string, unknown> {
  return {
    channelData: {
      channel: { id: "CHANNEL" },
      team: { id: "TEAM" },
      tenant: { id: "TENANT" },
    },
    conversation: { conversationType: input.conversationType, id: "CONV" },
    entities: [
      {
        mentioned: { id: "BOT", name: "eve Bot" },
        text: "<at>eve Bot</at>",
        type: "mention",
      },
    ],
    from: { id: "USER", name: "Ada" },
    id: "ACTIVITY_1",
    recipient: { id: "BOT", name: "eve Bot" },
    serviceUrl: "https://smba.example.test/teams",
    text: input.text ?? "hello",
    textFormat: "xml",
    type: "message",
  };
}
