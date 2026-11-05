import type { SortedResult } from "fumadocs-core/search";
import { describe, expect, it } from "vitest";
import { rankTitleMatches } from "./search-ranking";

const page = (title: string): SortedResult => ({
  content: title,
  id: title,
  type: "page",
  url: `/${title}`,
});
const hit = (content: string): SortedResult => ({ content, id: content, type: "text", url: "#" });

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

  it("ranks a title by where the whole word appears and keeps search order otherwise", () => {
    const results = [
      page("Slackware"),
      page("Slackware and Slack"),
      page("Tools"),
      page("Use Slack"),
    ];

    expect(rankTitleMatches(results, "slack").map((result) => result.content)).toEqual([
      "Slackware and Slack",
      "Use Slack",
      "Slackware",
      "Tools",
    ]);
  });

  it("doesn't promote integration pages", () => {
    const results = [
      page("Custom Channels"),
      { ...page("Slack"), url: "/integrations/slack" },
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
