import { expect, it } from "vitest";

import * as generic from "#public/experimental/channels/index.js";
import * as github from "#public/experimental/channels/github.js";
import { describeGitHubEvent } from "#public/channels/github/subscriptions.js";

it("exports describeGitHubEvent from the GitHub subpath only", () => {
  expect(Object.keys(github)).toEqual(["describeGitHubEvent"]);
  expect(github.describeGitHubEvent).toBe(describeGitHubEvent);
  expect(Object.keys(generic)).not.toContain("describeGitHubEvent");
});
