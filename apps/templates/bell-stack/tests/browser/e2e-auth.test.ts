import { createServer, type Server } from "node:http";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { restrictBrowserRequests } from "../../scripts/browser-test-auth";

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

it.runIf(process.env.BELL_TEST_LOCAL_CHROME === "1")("keeps browser-test credentials on their exact origin across redirects", async () => {
  const headers = { authorization: "Basic synthetic-only", "x-vercel-protection-bypass": "synthetic-bypass" };
  let contacted = false;
  const received: Record<string, string | string[] | undefined> = {}, errors: unknown[] = [];
  const sink = createServer((_request, response) => { contacted = true; response.end("unexpected"); });
  const target = await listen(sink);
  const source = createServer((request, response) => {
    for (const name of Object.keys(headers)) received[name] = request.headers[name];
    response.writeHead(302, { location: target });
    response.end();
  });
  let browser;
  try {
    const origin = await listen(source);
    browser = await chromium.launch({ headless: true, ...(process.env.TEST_CHROME_PATH ? { executablePath: process.env.TEST_CHROME_PATH } : { channel: "chrome" }) });
    const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage();
    await restrictBrowserRequests(context, page, origin, headers, (error: unknown) => errors.push(error));
    await expect(page.goto(origin)).rejects.toThrow();
    expect(received).toEqual(headers);
    expect(contacted).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await Promise.all([source, sink].map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  }
}, 30_000);
