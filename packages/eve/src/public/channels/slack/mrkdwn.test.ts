import { describe, expect, it } from "vitest";

import {
  gfmToSlackMrkdwn,
  rewriteBareMentions,
  slackMrkdwnToGfm,
} from "#public/channels/slack/mrkdwn.js";

describe("rewriteBareMentions", () => {
  it("rewrites bare @USER tokens into Slack mention syntax", () => {
    expect(rewriteBareMentions("ping @U123 please")).toBe("ping <@U123> please");
  });

  it("leaves already-wrapped mentions alone", () => {
    expect(rewriteBareMentions("ping <@U123> please")).toBe("ping <@U123> please");
  });

  it("does not touch email-shaped runs", () => {
    expect(rewriteBareMentions("contact foo@bar.com")).toBe("contact foo@bar.com");
  });

  it("rewrites every occurrence in a single pass", () => {
    expect(rewriteBareMentions("@A and @B")).toBe("<@A> and <@B>");
  });
});

describe("gfmToSlackMrkdwn", () => {
  it("converts ** and __ bold to single-star bold", () => {
    expect(gfmToSlackMrkdwn("**a** and __b__")).toBe("*a* and *b*");
  });

  it("converts ~~strike~~ to ~strike~", () => {
    expect(gfmToSlackMrkdwn("~~gone~~")).toBe("~gone~");
  });

  it("converts [label](url) to <url|label>", () => {
    expect(gfmToSlackMrkdwn("see [docs](https://x.dev)")).toBe("see <https://x.dev|docs>");
  });

  it("leaves fenced code blocks untouched", () => {
    const fenced = "before\n```\n**not bold**\n```\nafter";
    expect(gfmToSlackMrkdwn(fenced)).toBe(fenced);
  });

  it("leaves inline code spans untouched", () => {
    expect(gfmToSlackMrkdwn("call `**foo**` here")).toBe("call `**foo**` here");
  });
});

describe("slackMrkdwnToGfm", () => {
  it("decodes user mentions with and without a display name", () => {
    expect(slackMrkdwnToGfm("hi <@U123|alice>")).toBe("hi @alice");
    expect(slackMrkdwnToGfm("hi <@U123>")).toBe("hi @U123");
  });

  it("decodes channel mentions", () => {
    expect(slackMrkdwnToGfm("see <#C1|general> and <#C2>")).toBe("see #general and #C2");
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

  it("leaves fenced and inline code untouched", () => {
    expect(slackMrkdwnToGfm("```\n*not bold*\n```")).toBe("```\n*not bold*\n```");
    expect(slackMrkdwnToGfm("call `*foo*` here")).toBe("call `*foo*` here");
  });
});
