import { describe, expect, it, vi } from "vitest";

import type { RequestSettlement } from "#channel/interaction-prompts.js";
import { settleApproval } from "#public/channels/slack/approval-cards.js";
import type { SlackChannelState, SlackEventContext } from "#public/channels/slack/slackChannel.js";

const APPROVAL_ID = "approval-1";

function channelWithPostedApprovalCard(state: Partial<SlackChannelState> = {}) {
  const request = vi.fn(async (_operation: string, _body: Record<string, unknown>) => ({
    ok: true,
  }));
  const channel = {
    slack: { channelId: "C123", request, threadTs: "111.222" } as Partial<
      SlackEventContext["slack"]
    >,
    state: {
      channelId: "C123",
      pendingApprovalCards: {
        [APPROVAL_ID]: {
          messageBlocks: [
            {
              actions: [
                {
                  action_id: `eve_input:tool-approval:${APPROVAL_ID}:button:0`,
                  text: { text: "Approve", type: "plain_text" },
                  type: "button",
                },
              ],
              title: { text: "Approve deployment?", type: "mrkdwn" },
              type: "card",
            },
          ],
          messageTs: "card-ts",
        },
      },
      teamId: null,
      threadTs: "111.222",
      ...state,
    },
  } as SlackEventContext;
  const updates = () =>
    request.mock.calls.filter(([operation]) => operation === "chat.update").map(([, body]) => body);
  return { channel, updates };
}

function settlement(overrides: Partial<RequestSettlement>): RequestSettlement {
  return { interactionId: APPROVAL_ID, kind: "approval", outcome: "accepted", ...overrides };
}

describe("settleApproval", () => {
  it("retires a withdrawn approval's card as no longer needed, not as answered", async () => {
    const { channel, updates } = channelWithPostedApprovalCard();

    await settleApproval(settlement({ outcome: "withdrawn" }), channel);

    expect(updates()).toEqual([
      expect.objectContaining({ channel: "C123", text: "No longer needed", ts: "card-ts" }),
    ]);
  });

  it("announces an approval answered by an unmapped responder as answered, crediting nobody", async () => {
    const { channel, updates } = channelWithPostedApprovalCard();

    await settleApproval(
      settlement({ outcome: "accepted", responder: { id: "custom:unmapped", type: "user" } }),
      channel,
    );

    const [update] = updates();
    expect(update?.text).toBe("Answered: Approve");
    expect(JSON.stringify(update?.blocks)).not.toContain("<@");
  });
});
