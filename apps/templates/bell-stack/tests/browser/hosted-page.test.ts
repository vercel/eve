import { afterEach, describe, expect, it, vi } from "vitest";
import { browserbase, localBrowser } from "@browserbasehq/stagehand";
import { BrowserSession, browserbaseLaunchOptions } from "../../server/browser/browser-session";
import type { ConversationState } from "../../server/browser/types";

function fixture() {
  const state: ConversationState = {
    id: "shared-test",
    traces: [],
    browser: { provider: "not-started", status: "idle" },
  };
  const session = new BrowserSession(state);
  const page = {
    url: async () => "https://example.com/",
    title: async () => "Example",
  };
  vi.spyOn(session, "start").mockResolvedValue();
  vi.spyOn(
    session as unknown as { gateCaptcha(): Promise<void> },
    "gateCaptcha",
  ).mockResolvedValue();
  Object.assign(session, {
    remoteSessionId: "private-session",
    browser: { context: { activePage: async () => page } },
    browserbase: {
      sessions: {
        retrieve: async () => ({ connectUrl: "wss://private-connection" }),
      },
    },
  });
  return { session, state, page };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("shared hosted-page integration boundary", () => {
  it("uses the existing page and exposes only the callback result", async () => {
    const { session, state, page } = fixture();
    const operation = vi.fn(async (active, connection, sessionId) => {
      expect(active).toBe(page);
      expect(connection).toBe("wss://private-connection");
      expect(sessionId).toBe("private-session");
      return { accepted: true };
    });
    expect(await session.withHostedPage(new AbortController().signal, operation)).toEqual({
      accepted: true,
    });
    expect(state.browser.url).toBe("https://example.com/");
    expect(JSON.stringify(state)).not.toContain("private-connection");
  });
  it("does not observe the page or run post-CAPTCHA snapshots after a private operation", async () => {
    const { session, state, page } = fixture();
    const title = vi.spyOn(page, "title"), url = vi.spyOn(page, "url");
    await session.withHostedPage(new AbortController().signal, async () => ({ submitted: true }), true);
    expect(title).not.toHaveBeenCalled();
    expect(url).not.toHaveBeenCalled();
    expect((session as unknown as { gateCaptcha: unknown }).gateCaptcha).toHaveBeenCalledTimes(1);
    expect(state.browser.url).toBeUndefined();
  });
  it("does no work for an already-cancelled call", async () => {
    const { session } = fixture();
    const operation = vi.fn();
    await expect(session.withHostedPage(AbortSignal.abort(), operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
  });
  it("releases the operation lock after a failed callback", async () => {
    const { session } = fixture();
    await expect(
      session.withHostedPage(new AbortController().signal, async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(
      session.withHostedPage(new AbortController().signal, async () => "next"),
    ).resolves.toBe("next");
  });
  it("always disables hosted recording", () => {
    const options = browserbaseLaunchOptions("test-key");
    expect(options.browserSettings.logSession).toBe(false);
    expect(options.browserSettings.recordSession).toBe(false);
    expect(options.userMetadata.networkLogging).toBe("false");
    expect(options.userMetadata.sessionRecording).toBe("false");
  });

  it.each([undefined, { country: "US" }])("keeps Verified and managed proxies enabled with location %j", (location) => {
    const options = browserbaseLaunchOptions("test-key", "test-context", location);
    expect(options.browserSettings).toMatchObject({
      verified: true,
      context: { id: "test-context", persist: true },
    });
    expect(options.keepAlive).toBe(true);
    expect(options.proxies).toEqual(location
      ? [{ type: "browserbase", geolocation: location }]
      : true);
  });

  it("retries hosted failures with Verified enabled and never falls back to local Chrome", async () => {
    vi.useFakeTimers();
    vi.stubEnv("STAGEHAND_BROWSER", "browserbase");
    vi.stubEnv("BROWSERBASE_API_KEY", "test-key");
    const launch = vi.spyOn(browserbase, "launch").mockRejectedValue(new Error("Synthetic launch failure"));
    const localLaunch = vi.spyOn(localBrowser, "launch");
    const state: ConversationState = {
      id: "verified-retry-test", traces: [],
      browser: { provider: "not-started", status: "idle" },
    };
    const session = new BrowserSession(state);
    const failure = expect(session.start()).rejects.toThrow("Synthetic launch failure");
    await vi.runAllTimersAsync();
    await failure;
    expect(launch).toHaveBeenCalledTimes(3);
    for (const [options] of launch.mock.calls) {
      expect(options).toMatchObject({ proxies: true, browserSettings: { verified: true } });
    }
    expect(localLaunch).not.toHaveBeenCalled();
  });
});
