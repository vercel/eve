import { describe, expect, it } from "vitest";

import { slackMrkdwnToGfm } from "#public/channels/slack/mrkdwn.js";

describe("slackMrkdwnToGfm", () => {
  it("decodes user mentions with and without a display name", () => {
    expect(slackMrkdwnToGfm("hi <@U123|alice>")).toBe("hi @alice");
    expect(slackMrkdwnToGfm("hi <@U123>")).toBe("hi @U123");
  });

  it("decodes channel mentions while retaining channel IDs", () => {
    expect(slackMrkdwnToGfm("see <#C1|general> and <#C2>")).toBe("see #general (C1) and #C2");
  });

  it("decodes broadcast mentions", () => {
    expect(slackMrkdwnToGfm("<!channel> <!here> <!everyone>")).toBe("@channel @here @everyone");
  });

  it("decodes link syntax with and without a label", () => {
    expect(slackMrkdwnToGfm("<https://x.dev|home>")).toBe("[home](https://x.dev)");
    expect(slackMrkdwnToGfm("<https://x.dev>")).toBe("https://x.dev");
  });

  it("upgrades paired *bold* and ~strike~ to GFM", () => {
    expect(slackMrkdwnToGfm("a *b* c ~d~")).toBe("a **b** c ~~d~~");
  });

  it("unescapes Slack control entities outside code", () => {
    expect(slackMrkdwnToGfm("a &lt; b &amp; c")).toBe("a < b & c");
    expect(slackMrkdwnToGfm("call `a &lt; b` here")).toBe("call `a &lt; b` here");
  });

  it("leaves fenced and inline code untouched", () => {
    expect(slackMrkdwnToGfm("```\n*not bold*\n```")).toBe("```\n*not bold*\n```");
    expect(slackMrkdwnToGfm("call `*foo*` here")).toBe("call `*foo*` here");
  });
});
