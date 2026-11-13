import { afterEach, describe, expect, it, vi } from "vitest";

import taskHooks from "../../agent/hooks/task-state";
import { closeBrowserRuntime, runBrowserOperation } from "../../agent/lib/browser-runtime";
import { applyCaptchaTransition, closeTaskBrowser, taskState } from "../../agent/lib/task-state";
import { BrowserSession, CaptchaHandoffError } from "../../server/browser/browser-session";
import { ContextContainer, contextStorage } from "../../node_modules/eve/dist/src/context/container.js";

afterEach(() => vi.restoreAllMocks());

describe("resuming a browser after CAPTCHA handoff", () => {
  it.each(["errored", "timed_out"] as const)(
    "observes the existing page after the user replies to a %s challenge", (status) =>
    contextStorage.run(new ContextContainer(), async () => {
      const id = `captcha-recovery-${status}`;
      taskState.update(current => ({
        ...current, sessionId: id, status: "waiting_for_user", waitReason: "captcha",
        captcha: { status, attemptCount: 1, journal: [] },
      }));
      const page = {
        snapshot: vi.fn(async () => ({ formattedTree: "Account home", xpathMap: {} })),
        url: async () => "https://shop.example/account",
        title: async () => "Account",
      };
      const close = vi.fn(async () => {});
      await runBrowserOperation(id, async browser => {
        vi.spyOn(browser, "start").mockResolvedValue();
        vi.spyOn(browser, "close").mockImplementation(close);
        Object.assign(browser, { stagehand: {
          experimentalBatch: <T>(operation: (context: { page: typeof page }) => Promise<T>) => operation({ page }),
        } });
      });
      try {
        // Before the reply, the restored challenge must still gate all browser work.
        expect(await runBrowserOperation(id, browser => browser.snapshot())).toMatchObject({
          result: { status: "waiting_for_user", reason: "captcha" },
        });
        expect(page.snapshot).not.toHaveBeenCalled();

        await taskHooks.events!["message.received"]!({
          type: "message.received", data: { message: "done" }, meta: { id: "new-reply" },
        } as never, { session: { id } } as never);
        expect(await runBrowserOperation(id, browser => browser.snapshot())).toMatchObject({
          result: { tree: "Account home", url: "https://shop.example/account" },
          workbench: { captcha: { status: "idle" } },
        });
        expect(page.snapshot).toHaveBeenCalledTimes(2);
        expect(close).not.toHaveBeenCalled();
        expect(taskState.get()).toMatchObject({ status: "running", captcha: { status: "idle" } });
      } finally {
        await closeBrowserRuntime(id);
      }
    }),
  );

  it("does not let an old replayed message clear a new handoff", () =>
    contextStorage.run(new ContextContainer(), async () => {
      const id = "captcha-replayed-reply";
      taskState.update(current => ({ ...current, sessionId: id, processedEventIds: ["old-reply"] }));
      taskState.update(current => applyCaptchaTransition(current, {
        id: "challenge-start", type: "started", at: new Date().toISOString(),
      }));
      taskState.update(current => applyCaptchaTransition(current, {
        id: "challenge-error", type: "errored", at: new Date().toISOString(),
      }));
      await taskHooks.events!["message.received"]!({
        type: "message.received", data: { message: "done" }, meta: { id: "old-reply" },
      } as never, { session: { id } } as never);
      expect(taskState.get()).toMatchObject({ status: "waiting_for_user", captcha: { status: "errored" } });
    }));

  it("preserves CAPTCHA handoff errors from secure login", async () => {
    const browser = new BrowserSession({
      id: "login-handoff", traces: [], browser: { provider: "not-started", status: "idle" },
    }, { captcha: { status: "errored" } });
    vi.spyOn(browser, "start").mockResolvedValue();
    await expect(browser.secureLogin({
      allowedHosts: ["shop.example"], username: "fixture", password: "synthetic-only",
      usernameTarget: "#username", passwordTarget: "#password", submitTarget: "#submit",
    })).rejects.toBeInstanceOf(CaptchaHandoffError);
  });

  it("drops a closed browser's challenge before starting a replacement", () =>
    contextStorage.run(new ContextContainer(), () => {
      const record = { ...taskState.get(), captcha: { status: "timed_out" as const, attemptCount: 1, journal: [] } };
      expect(closeTaskBrowser(record).captcha).toBeUndefined();
    }));
});
