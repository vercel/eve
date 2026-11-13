import { browserbase, Stagehand } from "@browserbasehq/stagehand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ retrieve: vi.fn(), update: vi.fn(), debug: vi.fn() }));
vi.mock("@browserbasehq/sdk", () => ({ default: class {
  sessions = { retrieve: mocks.retrieve, update: mocks.update, debug: mocks.debug };
} }));

import { BrowserSession } from "../../server/browser/browser-session";
import { issueBrowserHandoffToken, resolveBrowserHandoffLiveViewUrl } from "../../server/browser/handoff";
import type { ConversationState } from "../../server/browser/types";

const secret = "synthetic-handoff-secret-at-least-32-bytes";
const unsafeMetadata = [
  {},
  { networkLogging: "true", sessionRecording: "false" },
  { networkLogging: "false" },
  { networkLogging: "false", sessionRecording: "true" },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("STAGEHAND_BROWSER", "browserbase");
  vi.stubEnv("BROWSERBASE_API_KEY", "synthetic-only");
  vi.stubEnv("BROWSERBASE_CONTEXT_ID", "");
  mocks.update.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("hosted recording privacy", () => {
  it.each(unsafeMetadata)("replaces a persisted browser with unsafe privacy markers: %j", async userMetadata => {
    vi.useFakeTimers();
    mocks.retrieve.mockResolvedValue({ userMetadata });
    const remote = {
      sessionId: "replacement-browser", closed: false, close: vi.fn(async () => {}),
      context: { pages: async () => [] },
    };
    const launch = vi.spyOn(browserbase, "launch").mockResolvedValue(remote as never);
    const connect = vi.spyOn(browserbase, "connect");
    vi.spyOn(Stagehand, "create").mockResolvedValue({ close: async () => {} } as never);
    const state: ConversationState = {
      id: "recording-recovery", traces: [],
      browser: { provider: "browserbase", status: "idle", sessionId: "previous-browser" },
    };
    const browser = new BrowserSession(state);
    const started = browser.start();
    await vi.runAllTimersAsync();
    await started;
    expect(connect).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith("previous-browser", { status: "REQUEST_RELEASE" });
    expect(launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      browserSettings: expect.objectContaining({ logSession: false, recordSession: false }),
      userMetadata: expect.objectContaining({ networkLogging: "false", sessionRecording: "false" }),
    }));
    expect(state.browser.sessionId).toBe("replacement-browser");
    await browser.close();
  });

  it.each(unsafeMetadata)("refuses handoff to unsafe privacy markers: %j", async userMetadata => {
    mocks.retrieve.mockResolvedValue({ userMetadata });
    const token = issueBrowserHandoffToken({ eveSessionId: "eve-session", browserSessionId: "browser-session" }, { secret });
    await expect(resolveBrowserHandoffLiveViewUrl(token, { secret })).rejects.toMatchObject({ code: "unavailable" });
    expect(mocks.debug).not.toHaveBeenCalled();
  });

  it("resolves a handoff only after verifying recording is disabled", async () => {
    mocks.retrieve.mockResolvedValue({ userMetadata: { networkLogging: "false", sessionRecording: "false" } });
    mocks.debug.mockResolvedValue({ debuggerFullscreenUrl: "https://www.browserbase.com/devtools-fullscreen/fixture.html?wss=wss%3A%2F%2Fconnect.browserbase.com%3FsessionId%3Dfixture" });
    const token = issueBrowserHandoffToken({ eveSessionId: "eve-session", browserSessionId: "browser-session" }, { secret });
    await expect(resolveBrowserHandoffLiveViewUrl(token, { secret })).resolves.toContain("browserbase.com");
    expect(mocks.retrieve).toHaveBeenCalledWith("browser-session");
    expect(mocks.debug).toHaveBeenCalledWith("browser-session");
  });
});
