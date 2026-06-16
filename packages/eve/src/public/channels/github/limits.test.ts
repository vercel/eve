import { describe, expect, it } from "vitest";

import { splitGitHubCommentBody } from "#public/channels/github/limits.js";

describe("GitHub limit helpers", () => {
  it("splits comment bodies at readable boundaries", () => {
    expect(splitGitHubCommentBody("one two three four", 8)).toEqual(["one two", "three", "four"]);
  });
});
