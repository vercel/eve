import { expect, it } from "vitest";

import * as generic from "#public/experimental/channels/index.js";
import * as slack from "#public/experimental/channels/slack.js";
import { describeSlackEvent } from "#public/channels/slack/subscriptions.js";

it("exports describeSlackEvent from the Slack subpath only", () => {
  expect(Object.keys(slack)).toEqual(["describeSlackEvent"]);
  expect(slack.describeSlackEvent).toBe(describeSlackEvent);
  expect(Object.keys(generic)).not.toContain("describeSlackEvent");
});
