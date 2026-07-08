import { describe, expect, it } from "vitest";

import { callGitHubApi } from "#public/channels/github/index.js";
import { verifyLinearRequest } from "#public/channels/linear/index.js";
import { defaultInputRequestedHandler } from "#public/channels/slack/index.js";

describe("channel helper runtime exports", () => {
  it("loads helpers from their public channel barrels", () => {
    expect(callGitHubApi).toBeTypeOf("function");
    expect(verifyLinearRequest).toBeTypeOf("function");
    expect(defaultInputRequestedHandler).toBeTypeOf("function");
  });
});
