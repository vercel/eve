import { chromium } from "playwright-core";
import { expect, it } from "vitest";

import {
  bundleTemplate,
  servePage,
} from "#internal/testing/channel-conformance/web-chat-driver.js";
import { testTurnFacts } from "#internal/testing/events.js";
import { linesOf } from "#protocol/session-lines.js";
import type { SessionEvent } from "#protocol/session-event.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/session-http.js";

type BrowserHistory = {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
};
declare const History: { prototype: BrowserHistory };
declare const window: { history: BrowserHistory; sessionRouteChanges: string[] };
declare const document: { documentElement: { scrollWidth: number } };

it("updates the session URL once while stream cursors advance", async () => {
  const server = await servePage("http://127.0.0.1:1", await bundleTemplate());
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const state = { nextRouterState: "preserved" };
      const replaceState = History.prototype.replaceState;
      replaceState.call(window.history, state, "");
      const changes: string[] = [];
      Object.assign(window, { sessionRouteChanges: changes });
      History.prototype.replaceState = function (
        this: BrowserHistory,
        ...args: Parameters<BrowserHistory["replaceState"]>
      ) {
        changes.push(String(args[2]));
        return replaceState.apply(this, args);
      };
      // Framework routing must not remount the chat and detach its stream.
      window.history.replaceState = () => {
        throw new Error("The router's replaceState must not handle session URLs.");
      };
    });

    let acceptMessage!: () => void;
    const accepted = new Promise<void>((resolve) => {
      acceptMessage = resolve;
    });
    const facts = testTurnFacts(0, "Done.", ["d_0"]);
    const progress: SessionEvent[] = Array.from({ length: 200 }, () => ({
      type: "content.delta",
      scope: { runId: "run_0", turnId: "turn_0" },
      data: { partId: "part_0", kind: "text", delta: "." },
    }));
    const lines = linesOf(
      [...facts.slice(0, 4), ...progress, ...facts.slice(4)],
      "2026-10-27T00:00:00.000Z",
    );
    await page.route("**/eve/v1/**", async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const body = request.postDataJSON() as { message?: unknown } | null;
        await route.fulfill({
          status: 202,
          json: { sessionId: "session_1", deliveryId: body?.message ? "d_0" : undefined },
        });
        if (body?.message) acceptMessage();
        return;
      }
      await accepted;
      const start = Number(new URL(request.url()).searchParams.get("startIndex") ?? 0);
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/x-ndjson",
          [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
          [EVE_STREAM_TAIL_INDEX_HEADER]: String(lines.length - 1),
        },
        body: lines
          .slice(start)
          .map((line) => `${JSON.stringify(line)}\n`)
          .join(""),
      });
    });
    await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
    await page.goto(server.url);
    const composer = page.getByPlaceholder("Send a message…");
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" && response.url().endsWith("/eve/v1/session"),
      ),
      composer.fill("Hello"),
    ]);
    expect(new URL(page.url()).pathname).toBe("/");
    await composer.press("Enter");
    await page.getByText("Done.", { exact: true }).waitFor();

    expect(new URL(page.url()).pathname).toBe("/s/session_1");
    expect(await page.evaluate(() => window.history.state)).toEqual({
      nextRouterState: "preserved",
    });
    const changes = await page.evaluate(() => window.sessionRouteChanges);
    expect(changes).toEqual(["/s/session_1"]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await composer.isEditable()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.close();
  }
});
