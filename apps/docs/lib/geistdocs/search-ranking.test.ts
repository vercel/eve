import { describe, expect, it } from "vitest";
import { rankTitleMatches } from "./search-ranking";

const page = (title: string) => ({ content: title, type: "page", url: `/${title}` });
const hit = (content: string) => ({ content, type: "text", url: "#" });

describe("rankTitleMatches", () => {
  it("puts the page titled with the query ahead of pages that only mention it", () => {
    const results = [
      page("Custom Channels"),
      hit("slackContinuationToken"),
      page("Channels"),
      hit("Slack"),
      page("Slack Reference"),
      hit("Slack options"),
      page("Slack"),
      hit("Answer mentions and DMs"),
    ];

    expect(rankTitleMatches(results, " slack ").map((result) => result.content)).toEqual([
      "Slack",
      "Answer mentions and DMs",
      "Slack Reference",
      "Slack options",
      "Custom Channels",
      "slackContinuationToken",
      "Channels",
      "Slack",
    ]);
  });

  it("ranks a whole-word title match above a partial one and keeps search order otherwise", () => {
    const results = [page("Slackware"), page("Tools"), page("Use Slack"), page("Hooks")];

    expect(rankTitleMatches(results, "slack").map((result) => result.content)).toEqual([
      "Use Slack",
      "Slackware",
      "Tools",
      "Hooks",
    ]);
  });

  it("doesn't promote integration pages", () => {
    const results = [
      page("Custom Channels"),
      { content: "Slack", type: "page", url: "/integrations/slack" },
      page("Slack"),
    ];

    expect(rankTitleMatches(results, "slack").map((result) => result.url)).toEqual([
      "/Slack",
      "/Custom Channels",
      "/integrations/slack",
    ]);
  });

  it("returns results unchanged for an empty query", () => {
    const results = [page("Tools"), hit("defineTool")];

    expect(rankTitleMatches(results, "  ")).toEqual(results);
  });
});
