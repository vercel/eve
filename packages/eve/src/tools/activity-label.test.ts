import { describe, expect, it } from "vitest";

import { bash } from "#tools/provided/bash.js";
import { glob } from "#tools/provided/glob.js";
import { grep } from "#tools/provided/grep.js";
import { loadSkill } from "#tools/provided/load-skill.js";
import { readFile } from "#tools/provided/read-file.js";
import { webFetch } from "#tools/provided/web-fetch.js";
import { resolveWebSearchActivityLabel } from "#harness/provider-tool-schemas.js";
import { writeFile } from "#tools/provided/write-file.js";

describe("provided tool activity labels", () => {
  it("labels every tool previously formatted by Slack", () => {
    expect(bash.activity?.label({ command: "pnpm test" })).toBe("Run pnpm test");
    expect(glob.activity?.label({ pattern: "**/*.ts" })).toBe("Find **/*.ts");
    expect(grep.activity?.label({ pattern: "slackActivityMessage" })).toBe(
      "Search slackActivityMessage",
    );
    expect(loadSkill.activity?.label({ skill: "technical-writing" })).toBe(
      "Load technical-writing",
    );
    expect(readFile.activity?.label({ filePath: "channels/slack/activity.ts" })).toBe(
      "Read channels/slack/activity.ts",
    );
    expect(webFetch.activity?.label({ url: "https://docs.slack.dev" })).toBe(
      "Fetch https://docs.slack.dev",
    );
    expect(resolveWebSearchActivityLabel({ query: "Slack plan blocks" })).toBe(
      "Search Slack plan blocks",
    );
    expect(writeFile.activity?.label({ content: "", filePath: "activity.ts" })).toBe(
      "Write activity.ts",
    );
  });

  it("handles provider-specific web search inputs", () => {
    expect(resolveWebSearchActivityLabel({ objective: "Find Slack docs" })).toBe(
      "Search Find Slack docs",
    );
    expect(
      resolveWebSearchActivityLabel({ action: { queries: ["Slack docs", "Block Kit"] } }),
    ).toBe("Search Slack docs");
  });
});
