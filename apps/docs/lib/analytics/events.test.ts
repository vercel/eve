import { describe, expect, it } from "vitest";
import {
  analyticsEvents,
  countMarkdownSuggestions,
  getAnalyticsUrl,
  getCountBucket,
  getDocsSurface,
  getMarkdownFormat,
  getQueryLengthBucket,
  getResponseOutcome,
  normalizeSearchQuery,
} from "./events";

describe("docs analytics", () => {
  it("keeps event names unique", () => {
    const names = Object.values(analyticsEvents);
    expect(new Set(names).size).toBe(names.length);
  });

  it("removes query-string input from server analytics URLs", () => {
    expect(getAnalyticsUrl("https://eve.dev/api/chat")).toBe("https://eve.dev/api/chat");
    expect(getAnalyticsUrl("https://eve.dev/docs/missing?token=secret#hash")).toBe(
      "https://eve.dev/docs/missing",
    );
    expect(getAnalyticsUrl("not a URL")).toBeUndefined();
  });

  it.each([
    ["/", "home"],
    ["https://eve.dev/docs/agent-config?tab=files", "docs"],
    ["/integrations/slack", "integrations"],
    ["/templates/eve-chat-template", "templates"],
    ["/api/search", "other"],
    [undefined, "other"],
  ])("classifies %s as %s without retaining the URL", (value, expected) => {
    expect(getDocsSurface(value)).toBe(expected);
  });

  it("uses bounded result-count buckets", () => {
    expect([0, 1, 5, 6, 10, 11, 500].map(getCountBucket)).toEqual([
      "0",
      "1-5",
      "1-5",
      "6-10",
      "6-10",
      "11+",
      "11+",
    ]);
  });

  it("uses bounded query-length buckets", () => {
    expect(getQueryLengthBucket("a")).toBe("1-2");
    expect(getQueryLengthBucket("agent")).toBe("3-10");
    expect(getQueryLengthBucket("how do sessions work")).toBe("11-30");
    expect(getQueryLengthBucket("how do I deploy an agent to my own infrastructure")).toBe("31+");
  });

  it("normalizes and bounds recorded search terms", () => {
    expect(normalizeSearchQuery("  Durable   Agents  ")).toBe("durable agents");
    expect(normalizeSearchQuery("ＡＧＥＮＴ")).toBe("agent");
    expect(normalizeSearchQuery("a".repeat(200))).toHaveLength(120);
  });

  it.each([
    [200, "accepted"],
    [399, "accepted"],
    [400, "client_error"],
    [499, "client_error"],
    [500, "server_error"],
  ])("classifies status %i as %s", (status, expected) => {
    expect(getResponseOutcome(status)).toBe(expected);
  });

  it("classifies Markdown negotiation without retaining the requested path", () => {
    expect(getMarkdownFormat("/docs/missing.md", null)).toBe("md");
    expect(getMarkdownFormat("/docs/missing.mdx", null)).toBe("mdx");
    expect(getMarkdownFormat("/docs/missing", "text/markdown")).toBe("accept");
    expect(getMarkdownFormat("/docs/missing", "text/html")).toBe("unknown");
  });

  it("counts smart 404 suggestions without retaining their destinations", () => {
    expect(
      countMarkdownSuggestions(
        "# Page Not Found\n\n- [Agent config](/docs/agent-config.md): Configure an agent.\n- [Tools](/docs/tools.md): Add tools.\n",
      ),
    ).toBe(2);
    expect(
      countMarkdownSuggestions("# Page Not Found\n\nAll pages: [/llms.txt](/llms.txt)\n"),
    ).toBe(0);
  });
});
