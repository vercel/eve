import { describe, expect, it } from "vitest";

import { slackMessageDeepLink } from "./slack-connect.js";

describe("slackMessageDeepLink", () => {
  it("adds tab=messages to an app_redirect install URL", () => {
    expect(slackMessageDeepLink("https://slack.com/app_redirect?app=A0&team=T0")).toBe(
      "https://slack.com/app_redirect?app=A0&team=T0&tab=messages",
    );
  });

  it("overrides an existing tab so it always lands on the Messages tab", () => {
    expect(slackMessageDeepLink("https://slack.com/app_redirect?app=A0&team=T0&tab=about")).toBe(
      "https://slack.com/app_redirect?app=A0&team=T0&tab=messages",
    );
  });

  it("leaves a non-app_redirect URL untouched", () => {
    expect(slackMessageDeepLink("https://acme.slack.com")).toBe("https://acme.slack.com");
  });

  it("leaves an app_redirect URL missing app or team untouched", () => {
    expect(slackMessageDeepLink("https://slack.com/app_redirect?app=A0")).toBe(
      "https://slack.com/app_redirect?app=A0",
    );
  });

  it("returns an unparseable string unchanged", () => {
    expect(slackMessageDeepLink("not a url")).toBe("not a url");
  });
});
