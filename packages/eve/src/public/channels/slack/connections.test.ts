import { describe, expect, it } from "vitest";

import {
  buildAuthCompletedText,
  buildAuthEphemeralBlocks,
  buildAuthRequiredPublicText,
  formatConnectionDisplayName,
} from "#public/channels/slack/connections.js";
import {
  parseSignInCancelTarget,
  SIGN_IN_CANCEL_ACTION_ID,
} from "#public/channels/slack/sign-in-cancel.js";

describe("formatConnectionDisplayName", () => {
  it("title-cases the first character", () => {
    expect(formatConnectionDisplayName("linear")).toBe("Linear");
  });

  it("returns empty strings unchanged", () => {
    expect(formatConnectionDisplayName("")).toBe("");
  });

  it("leaves already-capitalized names alone", () => {
    expect(formatConnectionDisplayName("GitHub")).toBe("GitHub");
  });
});

describe("buildAuthRequiredPublicText", () => {
  it("names who the thread is waiting on when the link was sent privately", () => {
    expect(buildAuthRequiredPublicText({ displayName: "Linear", recipientUserId: "U777" })).toBe(
      "Paused: waiting for <@U777> to connect Linear…",
    );
  });

  it("notes when the link could not be sent privately", () => {
    expect(buildAuthRequiredPublicText({ displayName: "Linear", recipientUserId: null })).toBe(
      "Linear needs to be connected to continue, but the sign-in link couldn't be sent privately.",
    );
  });
});

describe("buildAuthCompletedText", () => {
  it("renders the success outcome with a check glyph", () => {
    expect(buildAuthCompletedText({ displayName: "Linear", outcome: "authorized" })).toBe(
      ":white_check_mark: Linear connected",
    );
  });

  it("renders failure outcomes with a cross glyph and the outcome label", () => {
    expect(buildAuthCompletedText({ displayName: "Linear", outcome: "failed" })).toBe(
      ":x: Linear authorization failed",
    );
  });

  it("appends an optional reason in parentheses", () => {
    expect(
      buildAuthCompletedText({
        displayName: "Linear",
        outcome: "timed-out",
        reason: "the code expired",
      }),
    ).toBe(":x: Linear authorization timed-out (the code expired)");
  });

  it("reports a cancelled sign-in plainly", () => {
    expect(
      buildAuthCompletedText({
        displayName: "Linear",
        outcome: "declined",
        reason: "Cancelled because a new message arrived.",
      }),
    ).toBe("Linear sign-in cancelled");
  });
});

describe("buildAuthEphemeralBlocks", () => {
  it("names the service and why before a Connect button to the challenge URL", () => {
    expect(
      buildAuthEphemeralBlocks({
        displayName: "Linear",
        url: "https://connect.example.com/authorize/sca_abc",
      }),
    ).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Connect Linear*\nTo continue, I need access to your Linear account. Only you can see this message.",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Connect Linear" },
            url: "https://connect.example.com/authorize/sca_abc",
            style: "primary",
          },
        ],
      },
    ]);
  });

  it("says the turn is paused and offers Cancel when the sign-in holds a turn", () => {
    const target = { channelId: "C01", threadTs: "1700000000.000001", turnId: "turn_0" };
    const blocks = buildAuthEphemeralBlocks({
      cancel: target,
      displayName: "Linear",
      url: "https://connect.example.com/authorize/sca_abc",
    });
    expect((blocks[0] as { text: { text: string } }).text.text).toBe(
      "*Connect Linear*\nI've paused until you connect your Linear account or cancel. Only you can see this message.",
    );
    const cancel = (blocks[1] as { elements: Array<Record<string, unknown>> }).elements[1];
    expect(cancel).toMatchObject({
      action_id: SIGN_IN_CANCEL_ACTION_ID,
      text: { text: "Cancel", type: "plain_text" },
    });
    expect(parseSignInCancelTarget(cancel?.value)).toEqual(target);
  });

  it("keeps the button label within Slack's limit for long display names", () => {
    const blocks = buildAuthEphemeralBlocks({
      displayName: "x".repeat(90),
      url: "https://connect.example.com/authorize/sca_abc",
    });
    const actions = blocks[1] as { elements: Array<{ text: { text: string } }> };
    expect(actions.elements[0]!.text.text.length).toBeLessThanOrEqual(75);
  });

  it("adds the device code as a quiet hint after the button", () => {
    const blocks = buildAuthEphemeralBlocks({
      displayName: "Notion",
      url: "https://connect.example.com/authorize/sca_abc",
      userCode: "OTB-DGO",
    });
    expect(blocks.map((block) => (block as { type: string }).type)).toEqual([
      "section",
      "actions",
      "context",
    ]);
    expect(blocks[2]).toEqual({
      type: "context",
      elements: [
        { type: "mrkdwn", text: "If Notion asks for a confirmation code, enter `OTB-DGO`." },
      ],
    });
  });
});
