import { afterEach, describe, expect, it, vi } from "vitest";

const { release } = vi.hoisted(() => ({ release: vi.fn() }));
vi.mock("@browserbasehq/sdk", () => {
  class APIError extends Error {
    constructor(readonly status: number) { super("Provider failure"); }
  }
  return {
    default: class {
      static APIError = APIError;
      sessions = { update: release };
    },
  };
});

import Browserbase from "@browserbasehq/sdk";
import { BrowserSession } from "../../server/browser/browser-session";
import type { ConversationState } from "../../server/browser/types";
import { browserChannelEvents, closeBrowserRuntime, hasBrowserRuntime, runBrowserOperation } from "../../agent/lib/browser-runtime";
import taskHooks from "../../agent/hooks/task-state";
import { taskState } from "../../agent/lib/task-state";
import { ContextContainer, contextStorage } from "../../node_modules/eve/dist/src/context/container.js";

function fixture() {
  const state: ConversationState = {
    id: "restored-conversation",
    traces: [],
    browser: { provider: "browserbase", status: "idle", sessionId: "saved-browser" },
  };
  return { state, session: new BrowserSession(state) };
}

afterEach(() => vi.resetAllMocks());

describe("hosted browser retirement", () => {
  it("releases a persisted browser without starting or reattaching it", async () => {
    release.mockResolvedValue({ status: "COMPLETED" });
    const { state, session } = fixture();
    const start = vi.spyOn(session, "start");
    await session.close();
    await session.close();
    expect(start).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith("saved-browser", { status: "REQUEST_RELEASE" });
    expect(state.browser.sessionId).toBeUndefined();
  });

  it("keeps the browser ID when release fails so cleanup can retry", async () => {
    release.mockRejectedValueOnce(new Error("upstream private diagnostic"))
      .mockResolvedValueOnce({ status: "COMPLETED" });
    const { state, session } = fixture();
    await expect(session.close()).rejects.toThrow("The hosted browser could not be released");
    expect(state.browser.sessionId).toBe("saved-browser");
    await session.close();
    expect(release).toHaveBeenCalledTimes(2);
    expect(state.browser.sessionId).toBeUndefined();
  });

  it("accepts a provider 404 as already released", async () => {
    release.mockRejectedValue(new Browserbase.APIError(404, undefined, "missing", undefined));
    const { state, session } = fixture();
    await session.close();
    expect(state.browser.sessionId).toBeUndefined();
  });
});

describe("terminal cleanup in a fresh Eve worker", () => {
  it("shares one pending cleanup across overlapping cancellation callbacks", () =>
    contextStorage.run(new ContextContainer(), async () => {
      const id = "overlapping-cleanup";
      let finish!: () => void;
      const gate = new Promise<void>(resolve => { finish = resolve; });
      const close = vi.fn(() => gate);
      await runBrowserOperation(id, async browser => { vi.spyOn(browser, "close").mockImplementation(close); });
      const first = closeBrowserRuntime(id), second = closeBrowserRuntime(id);
      expect(close).toHaveBeenCalledOnce();
      expect(hasBrowserRuntime(id)).toBe(true);
      finish();
      await Promise.all([first, second]);
      expect(hasBrowserRuntime(id)).toBe(false);
    }));
  it.each(["session.completed", "session.failed"] as const)(
    "%s recovers the persisted browser and retains it until release succeeds", (event) =>
    contextStorage.run(new ContextContainer(), async () => {
      const retire = () => event === "session.completed"
        ? browserChannelEvents[event]({}, undefined, { session: { id: "fresh-worker-retirement" } })
        : browserChannelEvents[event]({ sessionId: "fresh-worker-retirement" });
      const id = "fresh-worker-retirement";
      taskState.update((current) => ({
        ...current,
        browser: { lifecycle: "active", sessionId: "persisted-browser" },
      }));
      release.mockRejectedValueOnce(new Error("Synthetic provider outage"))
        .mockResolvedValueOnce({ status: "COMPLETED" });
      expect(hasBrowserRuntime(id)).toBe(false);
      try {
        await expect(retire()).rejects.toThrow("could not be released");
        expect(taskState.get().browser.sessionId).toBe("persisted-browser");
        expect(hasBrowserRuntime(id)).toBe(true);
        await retire();
        expect(release).toHaveBeenNthCalledWith(2, "persisted-browser", { status: "REQUEST_RELEASE" });
        expect(taskState.get().browser).toMatchObject({ lifecycle: "closed" });
        expect(taskState.get().browser.sessionId).toBeUndefined();
        expect(hasBrowserRuntime(id)).toBe(false);
      } finally {
        release.mockResolvedValue({ status: "COMPLETED" });
        await closeBrowserRuntime(id);
      }
    }));
    
  it("turn.cancelled releases the persisted browser before clearing its ID", () =>
    contextStorage.run(new ContextContainer(), async () => {
      const id = "fresh-worker-cancel";
      taskState.update((current) => ({
        ...current,
        browser: { lifecycle: "active", sessionId: "persisted-browser" },
      }));
      release.mockResolvedValue({ status: "COMPLETED" });
      await taskHooks.events!["turn.cancelled"]!(
        { type: "turn.cancelled", meta: { id: "evt_cancel" } } as never,
        { session: { id } } as never,
      );
      expect(release).toHaveBeenCalledExactlyOnceWith("persisted-browser", { status: "REQUEST_RELEASE" });
      expect(taskState.get()).toMatchObject({ status: "canceled", browser: { lifecycle: "closed" } });
      expect(taskState.get().browser.sessionId).toBeUndefined();
      expect(hasBrowserRuntime(id)).toBe(false);
    }));
});
