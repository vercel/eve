import type { BrowserContext, Page } from "playwright-core";

export async function restrictBrowserRequests(context: BrowserContext, page: Page, origin: string, headers: Record<string, string>, onError: (error: unknown) => void) {
  const cdp = await context.newCDPSession(page);
  cdp.on("Fetch.requestPaused", ({ requestId, request }) => {
    const allowed = new URL(request.url).origin === origin;
    // CDP pauses each redirect; Playwright route header overrides persist across redirects.
    void cdp.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed
      ? { requestId, headers: Object.entries({ ...request.headers, ...headers }).map(([name, value]) => ({ name, value: String(value) })) }
      : { requestId, errorReason: "BlockedByClient" }).catch(onError);
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
}
