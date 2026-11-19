import { describe, expect, it } from "vitest";

import { BrowserSession } from "../../server/browser/browser-session.js";
import type { ConversationState } from "../../server/browser/types.js";

const live =
  process.env.BELL_LIVE_PROXY_LOCATION === "1" && Boolean(process.env.BROWSERBASE_API_KEY);

describe("opt-in live proxy location", () => {
  it.runIf(live)(
    "starts a Browserbase session with a San Francisco proxy request",
    async () => {
      const state: ConversationState = {
        id: "proxy-location-live",
        traces: [],
        browser: { provider: "not-started", status: "idle" },
      };
      const browser = new BrowserSession(state, {
        proxyLocation: {
          country: "US",
          state: "CA",
          city: "San Francisco",
        },
      });
      try {
        await browser.run([{ action: "goto", url: "https://ipinfo.io/json" }]);
        const page = await browser.snapshot();
        expect(page.pageStatus).toBe("live");
        expect(state.browser).toMatchObject({
          provider: "browserbase",
          proxyLocation: {
            country: "US",
            state: "CA",
            city: "San Francisco",
          },
        });
        console.log(
          JSON.stringify({
            status: "pass",
            requestedLocation: state.browser.proxyLocation,
            page: state.browser.url,
          }),
        );
      } finally {
        await browser.close();
      }
    },
    90_000,
  );
});
