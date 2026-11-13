import { chromium, type Browser } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserSession } from "../../server/browser/browser-session.js";
import type { ConversationState } from "../../server/browser/types.js";

const live = process.env.BELL_LIVE_CAPTCHA === "1" && Boolean(process.env.BROWSERBASE_API_KEY);
afterEach(() => vi.unstubAllEnvs());
describe("opt-in hosted CAPTCHA marker fixture", () => {
  it.runIf(live)(
    "subscribes before navigation, gates, re-observes, and cleans up",
    async () => {
      const state: ConversationState = {
        id: "captcha-live-fixture",
        traces: [],
        browser: { provider: "not-started", status: "idle" },
      };
      const session = new BrowserSession(state);
      let fixtureBrowser: Browser | undefined;
      try {
        const fixture = "https://bell-fixture.invalid/captcha";
        fixtureBrowser = await session.withHostedPage(new AbortController().signal, (_page, connectUrl) =>
          chromium.connectOverCDP(connectUrl));
        // Fulfill locally over CDP: the hosted browser cannot reach a localhost HTTP server.
        await fixtureBrowser.contexts()[0].route(fixture, route => route.fulfill({
          contentType: "text/html",
          body: "<title>captcha fixture</title><h1>After solve</h1><script>console.log('browserbase-solving-started');setTimeout(()=>console.log('browserbase-solving-finished'),50)</script>",
        }));
        const result = await session.run([
          { action: "goto", url: fixture },
          { action: "wait", milliseconds: 150 },
        ]);
        expect(result.completed).toBe(2);
        expect(state.traces.map((event) => event.name)).toEqual(
          expect.arrayContaining(["captcha.started", "captcha.finished", "captcha.observed"]),
        );
        const transitions = session.drainCaptchaTransitions();
        expect(transitions.map((event) => event.type)).toEqual(["started", "finished"]);
        expect(JSON.stringify({ transitions, traces: state.traces })).not.toMatch(
          /devtools|debuggerFullscreenUrl|wss=/i,
        );
      } finally {
        try {
          await fixtureBrowser?.close();
        } finally {
          await session.close();
        }
        expect(
          (session as unknown as { captchaSubscriptions: Map<string, unknown> })
            .captchaSubscriptions.size,
        ).toBe(0);
      }
    },
    60_000,
  );
});
