import { randomUUID } from "node:crypto";
import { chromium, type CDPSession } from "playwright-core";
import type { Page } from "@browserbasehq/stagehand";

/** One-use, top-frame GET only. Redirects and subsequent document requests fail closed. */
export function merchantRequestHandler(
  cdp: Pick<CDPSession, "send">,
  target: string,
  frameId: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) {
  let used = false;
  return {
    wasUsed: () => used,
    async handle(event: {
      requestId: string;
      frameId: string;
      resourceType: string;
      redirectedRequestId?: string;
      request: { url: string; method: string; headers: Record<string, string> };
    }) {
      const mainDocument = event.frameId === frameId && event.resourceType === "Document";
      if (
        signal.aborted ||
        (mainDocument &&
          (used ||
            event.redirectedRequestId ||
            event.request.url !== target ||
            event.request.method !== "GET"))
      ) {
        await cdp.send("Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "Aborted",
        });
        return;
      }
      const clean = Object.entries(event.request.headers)
        .filter(([name]) => !/^kya-(credential|disclosure-scope)$/i.test(name))
        .map(([name, value]) => ({ name, value: String(value) }));
      if (mainDocument) {
        used = true;
        clean.push(...Object.entries(headers).map(([name, value]) => ({ name, value })));
      }
      // Raw CDP overrides apply only to this request, unlike Playwright route header overrides.
      await cdp.send("Fetch.continueRequest", {
        requestId: event.requestId,
        headers: clean,
      });
    },
  };
}

/** Attach only a temporary network interceptor. Stagehand still owns navigation and lifecycle. */
export async function navigateWithMerchantProof(
  page: Page,
  connectUrl: string,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const marker = `__bell_merchant_${randomUUID().replaceAll("-", "")}`;
  let bridge: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let cdp: CDPSession | undefined;
  let abort: (() => void) | undefined;
  try {
    await page.evaluate((name) => {
      Reflect.set(globalThis, name, true);
    }, marker);
    bridge = await chromium.connectOverCDP(connectUrl, { timeout: 15_000 });
    signal.throwIfAborted();
    const pages = bridge.contexts().flatMap((context) => context.pages());
    const matches = await Promise.all(
      pages.map(
        async (candidate) =>
          await candidate
            .evaluate((name) => Reflect.get(globalThis, name) === true, marker)
            .catch(() => false),
      ),
    );
    const index = matches.indexOf(true);
    if (index < 0 || matches.filter(Boolean).length !== 1)
      throw new Error("Cannot identify the active browser page.");
    const candidate = pages[index];
    cdp = await candidate.context().newCDPSession(candidate);
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const handler = merchantRequestHandler(cdp, url, frameTree.frame.id, headers, signal);
    let rejectFailure!: (error: Error) => void;
    const failure = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject;
    });
    // A listener can reject before navigation begins. Keep the rejection handled throughout setup.
    void failure.catch(() => {});
    abort = () => {
      rejectFailure(new Error("Merchant navigation cancelled."));
      void cdp?.send("Page.stopLoading").catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    cdp.on("Fetch.requestPaused", (event) => {
      void handler
        .handle(event)
        .catch(() => rejectFailure(new Error("Merchant request interception failed.")));
    });
    await cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    signal.throwIfAborted();
    const response = await Promise.race([
      page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }),
      failure,
    ]);
    if (!handler.wasUsed() || !response || (await page.url()) !== url)
      throw new Error("Merchant navigation was not verified.");
    return response;
  } catch {
    signal.throwIfAborted();
    // Transport errors may contain credential-bearing connection URLs or protocol arguments.
    throw new Error(
      "Merchant navigation failed or redirected. No verified access was established.",
    );
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    if (cdp) {
      await cdp.send("Fetch.disable").catch(() => {});
      await cdp.detach().catch(() => {});
    }
    await page
      .evaluate((name) => {
        Reflect.deleteProperty(globalThis, name);
      }, marker)
      .catch(() => {});
    // On a CDP connection this disconnects the temporary client; Stagehand retains the browser.
    await bridge?.close().catch(() => {});
  }
}
