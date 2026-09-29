import { describe, expect, it } from "vitest";

import { planSlackDelivery, slackMessageVersion } from "#public/channels/slack/observation/plan.js";
import type { DesiredSlackView } from "#public/channels/slack/observation/view.js";

const view: DesiredSlackView = {
  revision: 2,
  status: "",
  messages: [
    {
      key: "root:activity:turn",
      kind: "activity",
      lifecycle: "mutable",
      text: "Researcher: working",
    },
    { key: "root:reply:part", kind: "reply", lifecycle: "retained", text: "The answer" },
  ],
};

describe("Slack observation delivery planning", () => {
  it("prioritizes a new reply, updates activity, and retains missing historical objects", () => {
    const initial = planSlackDelivery(view, {});
    expect(initial.map((operation) => [operation.kind, operation.key])).toEqual([
      ["create", "root:reply:part"],
      ["create", "root:activity:turn"],
    ]);
    const receipts = {
      "root:reply:part": {
        key: "root:reply:part",
        state: "confirmed" as const,
        providerMessageId: "1",
        appliedVersion: slackMessageVersion(view.messages[1]!),
      },
      "root:activity:turn": {
        key: "root:activity:turn",
        state: "confirmed" as const,
        providerMessageId: "2",
        appliedVersion: slackMessageVersion(view.messages[0]!),
      },
    };
    expect(planSlackDelivery(view, receipts)).toEqual([]);
    expect(planSlackDelivery({ ...view, messages: [] }, receipts)).toEqual([]);
    const changed = {
      ...view,
      revision: 3,
      messages: [{ ...view.messages[0]!, text: "Researcher: completed" }, view.messages[1]!],
    };
    expect(planSlackDelivery(changed, receipts)).toMatchObject([
      { kind: "update", key: "root:activity:turn", providerMessageId: "2" },
    ]);
    const correctedReply = {
      ...view,
      revision: 4,
      messages: [view.messages[0]!, { ...view.messages[1]!, text: "The corrected answer" }],
    };
    expect(planSlackDelivery(correctedReply, receipts)).toMatchObject([
      { kind: "update", key: "root:reply:part", providerMessageId: "1" },
    ]);
    expect(
      planSlackDelivery(view, {
        ...receipts,
        "root:reply:part": { key: "root:reply:part", state: "unknown" },
      }),
    ).toMatchObject([{ kind: "recover", key: "root:reply:part" }]);
  });
});
