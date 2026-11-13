import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { localBrowser, Stagehand, type StagehandBrowser } from "@browserbasehq/stagehand";
import { createAccess, fillAccess } from "../server/onepassword/extension";
import { callbackPage } from "../server/onepassword/http";

const connectUrl = "http://127.0.0.1:9353";
describe.skipIf(process.env.BELL_TEST_LOCAL_CHROME !== "1")("real Chrome with a synthetic Autofill extension", () => {
  let hosted: StagehandBrowser, stagehand: Stagehand, browser: Browser, context: BrowserContext;
  beforeAll(async () => {
    hosted = await localBrowser.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", port: 9353, headless: true });
    stagehand = await Stagehand.create({ browser: hosted, logging: { level: "off" } });
    browser = await chromium.connectOverCDP(connectUrl);
    context = browser.contexts()[0];
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send("Extensions.loadUnpacked", { path: fileURLToPath(new URL("./fixtures/onepassword-extension", import.meta.url)) });
    await cdp.detach();
    await context.route("https://login.bell-test.example/**", async route => {
      if (new URL(route.request().url()).pathname === "/home") {
        const body = route.request().postData() ?? "";
        await route.fulfill({ contentType: "text/html", body: body.includes("fixture-password") ? "<title>Signed in</title><p>Welcome fixture-user</p>" : "<title>Denied</title>" });
      } else await route.fulfill({ contentType: "text/html", body: '<title>Login</title><form method="post" action="/home"><input id="username" name="username"><input id="password" name="password" type="password"><button>Sign in</button></form>' });
    });
  }, 30_000);
  afterAll(async () => { await browser?.close(); await stagehand?.close(); await hosted?.close(); });
  it("loads the Autofill API alongside Stagehand and continues in the same browser after a verified fill", async () => {
    const page = await context.newPage();
    await page.goto("https://login.bell-test.example/login");
    const created = await createAccess(connectUrl, "synthetic-access", "synthetic-key", page.url());
    expect(created).toMatchObject({ requestId: "synthetic-request", entryId: "synthetic-entry" });
    await fillAccess(connectUrl, "synthetic-access", "synthetic-key", "synthetic-reference", page.url(), "https://login.bell-test.example/home");
    expect(await page.title()).toBe("Signed in");
    const pages = await hosted.context.pages();
    expect(await Promise.all(pages.map(page => page.url()))).toContain("https://login.bell-test.example/home");
    await page.close();
  }, 30_000);
  it("rejects duplicate matching tabs instead of choosing a login target arbitrarily", async () => {
    const first = await context.newPage(), second = await context.newPage();
    try {
      await Promise.all([first.goto("https://login.bell-test.example/login"), second.goto("https://login.bell-test.example/login")]);
      await expect(fillAccess(connectUrl, "synthetic-access", "synthetic-key", "synthetic-reference", first.url(), "https://login.bell-test.example/home")).rejects.toThrow();
      expect(await first.locator("#password").inputValue()).toBe("");
      expect(await second.locator("#password").inputValue()).toBe("");
    } finally { await first.close(); await second.close(); }
  });
  it("captures the OAuth fragment in a POST, clears it, and resumes only at a same-origin Eve callback", async () => {
    const requests: { url: string; body?: string | null }[] = [];
    await context.route("https://bell.bell-test.example/**", async route => {
      const request = route.request(), url = new URL(request.url());
      requests.push({ url: request.url(), body: request.postData() });
      if (url.pathname === "/api/onepassword/callback") {
        const response = callbackPage();
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
      } else if (url.pathname === "/api/onepassword/complete") await route.fulfill({ json: { location: "https://bell.bell-test.example/eve/v1/connections/op/callback/id/hook?result=opaque" } });
      else await route.fulfill({ body: "Connected", contentType: "text/html" });
    });
    const page = await context.newPage();
    try {
      await page.goto("https://bell.bell-test.example/api/onepassword/callback?code=synthetic-code&state=synthetic-state#integration_key=ops_synthetic");
      await page.waitForURL("**/eve/v1/connections/**");
      const posted = requests.find(request => request.url.endsWith("/complete"));
      expect(JSON.parse(posted!.body!)).toEqual({ code: "synthetic-code", state: "synthetic-state", integrationKey: "ops_synthetic" });
      expect(requests.every(request => !request.url.includes("ops_synthetic"))).toBe(true);
      expect(page.url()).not.toMatch(/integration_key|synthetic-code/);
    } finally { await page.close(); }
  });
});
