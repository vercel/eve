import { describe, expect, it } from "vitest";

import {
  buildChildSessionLimitGroupPost,
  CHILD_SESSION_LIMIT_APPROVE_ALL_ACTION_ID,
  CHILD_SESSION_LIMIT_STOP_TURN_ACTION_ID,
  childSessionLimitGroupFitsSlack,
  deriveChildSessionLimitGroupResponse,
} from "#public/channels/slack/child-session-limits.js";

function readApproveAllValue(blocks: readonly unknown[]): string {
  const card = blocks[0] as { actions: Array<{ value: string }> };
  return card.actions[0]!.value;
}

describe("child session-limit groups", () => {
  it("enforces Slack's group count and action-value limits", () => {
    expect(
      childSessionLimitGroupFitsSlack({
        groupId: "parent-turn-1",
        requestIds: Array.from({ length: 26 }, (_, index) => `limit-${String(index)}`),
        revision: 1,
      }),
    ).toBe(false);
    expect(
      childSessionLimitGroupFitsSlack({
        groupId: "parent-turn-1",
        requestIds: ["x".repeat(2_000)],
        revision: 1,
      }),
    ).toBe(false);
  });

  it("renders one Approve all action and decodes one continuation per request", () => {
    const post = buildChildSessionLimitGroupPost({
      groupId: "parent-turn-1",
      requestIds: ["limit-1", "limit-2"],
      revision: 3,
    });

    expect(post.text).toBe("2 child sessions need more tokens");
    expect(
      deriveChildSessionLimitGroupResponse({
        actionId: CHILD_SESSION_LIMIT_APPROVE_ALL_ACTION_ID,
        value: readApproveAllValue(post.blocks),
      }),
    ).toEqual({
      groupId: "parent-turn-1",
      optionId: "continue",
      responses: [
        { optionId: "continue", requestId: "limit-1" },
        { optionId: "continue", requestId: "limit-2" },
      ],
      revision: 3,
    });
  });

  it("preserves the explicit parent-turn stop path", () => {
    const post = buildChildSessionLimitGroupPost({
      groupId: "parent-turn-1",
      requestIds: ["limit-1", "limit-2"],
      revision: 1,
    });

    expect(
      deriveChildSessionLimitGroupResponse({
        actionId: CHILD_SESSION_LIMIT_STOP_TURN_ACTION_ID,
        value: readApproveAllValue(post.blocks),
      }),
    ).toMatchObject({
      responses: [
        { optionId: "stop", requestId: "limit-1" },
        { optionId: "stop", requestId: "limit-2" },
      ],
    });
  });

  it("rejects malformed and duplicate request snapshots", () => {
    expect(
      deriveChildSessionLimitGroupResponse({
        actionId: CHILD_SESSION_LIMIT_APPROVE_ALL_ACTION_ID,
        value: "not-json",
      }),
    ).toBeNull();
    expect(
      deriveChildSessionLimitGroupResponse({
        actionId: CHILD_SESSION_LIMIT_APPROVE_ALL_ACTION_ID,
        value: JSON.stringify({
          groupId: "parent-turn-1",
          requestIds: ["limit-1", "limit-1"],
          revision: 1,
        }),
      }),
    ).toBeNull();
  });
});
