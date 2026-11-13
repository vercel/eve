import { localBrowser } from "@browserbasehq/stagehand";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { submitPayment } from "../server/link/checkout-browser";
import type { CheckoutInput } from "../server/link/payment";

describe.skipIf(process.env.TEST_LINK_BROWSER !== "1")("Link checkout in Chrome", () => {
  let browser: Awaited<ReturnType<typeof localBrowser.launch>>, driver: Browser, page: Page;
  const origins = ["https://merchant.invalid", "https://payments.invalid"];
  const card = { card: { number: "4242424242424242", cvc: "918", exp_month: 12, exp_year: 2040 } };
  const input: CheckoutInput = { id: "spend_test", amount: 100, currency: "usd", credential: "card", fields: [{ field: "number", selector: "#number" }, { field: "cvc", selector: "#cvc" }], submit: { selector: "#pay" }, confirmation: { selector: "#receipt" } };
  const form = '<input id="number"><input id="cvc"><button id="pay" onclick="window.orders=(window.orders||[]).concat({number:document.querySelector(\'#number\').value,cvc:document.querySelector(\'#cvc\').value});document.querySelector(\'#receipt\').hidden=false">Pay</button><p id="receipt" hidden>Order confirmed</p>';
  const signal = () => new AbortController().signal;
  beforeAll(async () => {
    browser = await localBrowser.launch({ executablePath: process.env.TEST_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", port: 9357, headless: true });
    driver = await chromium.connectOverCDP("http://127.0.0.1:9357");
    const context = driver.contexts()[0];
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (![...origins, "https://untrusted.invalid"].includes(url.origin)) return route.abort();
      return route.fulfill({ contentType: "text/html", body: url.pathname === "/framed" ? '<iframe id="payment" src="https://payments.invalid/form"></iframe>' : form });
    });
    page = context.pages().find(candidate => !candidate.url().startsWith("chrome-extension:")) ?? await context.newPage();
  }, 30_000);
  afterAll(async () => { await driver?.close(); await browser?.close(); });
  beforeEach(async () => { await page.goto(`${origins[0]}/form`); });

  it("submits once and returns only safe status while the browser stays quarantined", async () => {
    const quarantine = vi.fn().mockResolvedValue(undefined);
    const result = await submitPayment(page, input, origins, async () => card, signal(), quarantine);
    expect(result.status).toBe("merchant_confirmation_observed");
    expect(JSON.stringify(result)).not.toContain(card.card.number);
    expect(await page.evaluate(() => Reflect.get(window, "orders"))).toEqual([{ number: card.card.number, cvc: card.card.cvc }]);
    expect(await page.locator("#number").inputValue()).toBe("");
    expect(quarantine).toHaveBeenCalledExactlyOnceWith();
  });
  it("supports explicitly trusted provider frames and rejects untrusted ones before retrieval", async () => {
    await page.goto(`${origins[0]}/framed`);
    await page.frameLocator("#payment").locator("#number").waitFor();
    const framed = { ...input, fields: input.fields.map(field => ({ ...field, frame: "#payment" })), submit: { ...input.submit, frame: "#payment" }, confirmation: { selector: "#receipt", frame: "#payment" } };
    const get = vi.fn(async () => card);
    await expect(submitPayment(page, framed, [origins[0]], get, signal(), async () => {})).rejects.toThrow("Unapproved payment frame");
    expect(get).not.toHaveBeenCalled();
    expect((await submitPayment(page, framed, origins, get, signal(), async () => {})).status).toBe("merchant_confirmation_observed");
  });
  it("does not resolve stale selectors on a replacement page", async () => {
    const get = async () => { await page.goto("https://untrusted.invalid/form"); return card; };
    await expect(submitPayment(page, input, origins, get, signal(), async () => {})).rejects.toThrow("stopped before submission");
    expect(await page.locator("#number").inputValue()).toBe("");
    expect(await page.evaluate(() => Reflect.get(window, "orders"))).toBeUndefined();
  });
  it("rejects ambiguous fields before retrieving credentials", async () => {
    await page.evaluate(() => document.body.append(document.querySelector("#number")!.cloneNode()));
    const get = vi.fn(async () => card);
    await expect(submitPayment(page, input, origins, get, signal(), async () => {})).rejects.toThrow("ambiguous");
    expect(get).not.toHaveBeenCalled();
  });
  it("checks cancellation after retrieval and writes nothing", async () => {
    const controller = new AbortController(), quarantine = vi.fn();
    await expect(submitPayment(page, input, origins, async () => { controller.abort(); return card; }, controller.signal, quarantine)).rejects.toThrow();
    expect(quarantine).not.toHaveBeenCalled();
    expect(await page.locator("#number").inputValue()).toBe("");
  });
  it("refuses to fill if persistent quarantine cannot be recorded", async () => {
    await expect(submitPayment(page, input, origins, async () => card, signal(), async () => { throw new Error("database unavailable"); })).rejects.toThrow("database unavailable");
    expect(await page.locator("#number").inputValue()).toBe("");
  });
  it("keeps quarantine after navigation and does not duplicate submission", async () => {
    await page.locator("#pay").evaluate(node => node.setAttribute("onclick", "location.href='/receipt'"));
    const quarantine = vi.fn().mockResolvedValue(undefined);
    const result = await submitPayment(page, { ...input, confirmation: undefined }, origins, async () => card, signal(), quarantine);
    expect(result.status).toBe("submission_attempted");
    await page.waitForURL("**/receipt");
    expect(quarantine).toHaveBeenCalledTimes(1);
  });
});
