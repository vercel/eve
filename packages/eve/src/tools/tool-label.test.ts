import { describe, expect, it } from "vitest";

import { bash } from "#tools/provided/bash.js";
import { glob } from "#tools/provided/glob.js";
import { grep } from "#tools/provided/grep.js";
import { loadSkill } from "#tools/provided/load-skill.js";
import { readFile } from "#tools/provided/read-file.js";
import { webFetch } from "#tools/provided/web-fetch.js";
import { resolveWebSearchActivityLabel } from "#harness/provider-tool-schemas.js";
import { writeFile } from "#tools/provided/write-file.js";

describe("provided tool labels", () => {
  it("labels every tool previously formatted by Slack", () => {
    expect(bash.label?.start({ command: "pnpm test" })).toBe("Run pnpm test");
    expect(glob.label?.start({ pattern: "**/*.ts" })).toBe("Find **/*.ts");
    expect(grep.label?.start({ pattern: "slackActivityMessage" })).toBe(
      "Search slackActivityMessage",
    );
    expect(loadSkill.label?.start({ skill: "technical-writing" })).toBe("Load technical-writing");
    expect(readFile.label?.start({ filePath: "channels/slack/activity.ts" })).toBe(
      "Read `channels/slack/activity.ts`",
    );
    expect(webFetch.label?.start({ url: "https://docs.slack.dev" })).toBe(
      "Fetch https://docs.slack.dev",
    );
    expect(resolveWebSearchActivityLabel({ query: "Slack plan blocks" })).toBe(
      "Search Slack plan blocks",
    );
    expect(writeFile.label?.start({ content: "", filePath: "activity.ts" })).toBe(
      "Write `activity.ts`",
    );
  });

  it("keeps inline-code file labels valid at the activity text limit", () => {
    const label = readFile.label?.start({ filePath: "a".repeat(600) });
    expect(label).toHaveLength(500);
    expect(label?.startsWith("Read `")).toBe(true);
    expect(label?.endsWith("`")).toBe(true);
  });

  it("falls back to a plain detail when a path contains a backtick", () => {
    expect(readFile.label?.start({ filePath: "with`tick.ts" })).toBe("Read with`tick.ts");
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
