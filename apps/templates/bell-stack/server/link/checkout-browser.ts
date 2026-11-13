import { randomUUID } from "node:crypto";
import type { Page as StagehandPage } from "@browserbasehq/stagehand";
import { chromium, type ElementHandle, type Page } from "playwright-core";
import { quarantineBrowser } from "../browser/privacy-lock";
import { httpsOrigin, paymentValues, type CheckoutInput } from "./payment";

async function element(page: Page, target: { selector: string; frame?: string }, origins: string[]): Promise<ElementHandle<HTMLElement | SVGElement>> {
  if (!origins.includes(httpsOrigin(page.url()))) throw new Error("Unapproved checkout page.");
  const frame = target.frame ? await (await page.locator(`css=${target.frame}`).elementHandle())?.contentFrame() : page.mainFrame();
  if (!frame || !origins.includes(httpsOrigin(frame.url()))) throw new Error("Unapproved payment frame.");
  const locator = frame.locator(`css=${target.selector}`);
  if (await locator.count() !== 1) throw new Error("Payment target is missing or ambiguous.");
  const handle = await locator.elementHandle();
  if (!handle) throw new Error("Payment target is unavailable.");
  return handle;
}

export async function submitPayment(page: Page, input: CheckoutInput, origins: string[], getCredentials: () => Promise<unknown>, signal: AbortSignal, quarantine = quarantineBrowser) {
  signal.throwIfAborted();
  const fields: ElementHandle<HTMLElement | SVGElement>[] = [];
  let submit: ElementHandle<HTMLElement | SVGElement> | undefined;
  let sensitive = false, attempted = false, confirmed = false;
  try {
    for (const target of input.fields) fields.push(await element(page, target, origins));
    submit = await element(page, input.submit, origins);
    const values = paymentValues(await getCredentials(), input);
    signal.throwIfAborted();
    await quarantine();
    sensitive = true;
    try {
      for (let i = 0; i < fields.length; i++) {
        signal.throwIfAborted();
        if (!origins.includes(httpsOrigin(page.url()))) throw new Error("Checkout page changed.");
        await fields[i].evaluate((node, { value, origins }) => {
          if (!node.isConnected || !origins.includes(location.origin) || !(node instanceof HTMLInputElement || node instanceof HTMLSelectElement)) throw new Error("Payment field changed.");
          const prototype = node instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
          node.dispatchEvent(new Event("input", { bubbles: true }));
          node.dispatchEvent(new Event("change", { bubbles: true }));
        }, { value: values[i], origins });
      }
      signal.throwIfAborted();
      if (!origins.includes(httpsOrigin(page.url())) || !await submit.evaluate((node, allowed) => node.isConnected && allowed.includes(location.origin), origins)) throw new Error("Checkout page changed.");
      attempted = true;
      await submit.click({ timeout: 10_000, noWaitAfter: true });
      if (input.confirmation) {
        try {
          await page.waitForTimeout(100);
          const receipt = await element(page, input.confirmation, origins);
          confirmed = await receipt.isVisible();
          await receipt.dispose();
        } catch { /* Submission alone does not establish payment success. */ }
      }
      return { id: input.id, status: confirmed ? "merchant_confirmation_observed" : "submission_attempted", verify_payment: true };
    } catch {
      signal.throwIfAborted();
      if (attempted) return { id: input.id, status: "outcome_unknown", verify_payment: true };
      throw new Error("Checkout stopped before submission. Check the existing Link request and browser before retrying.");
    }
  } finally {
    if (sensitive) {
      await Promise.all(fields.map(handle => handle.evaluate(node => {
        if (node.isConnected && (node instanceof HTMLInputElement || node instanceof HTMLSelectElement)) node.value = "";
      }).catch(() => {})));
    }
    await Promise.all([...fields, ...(submit ? [submit] : [])].map(handle => handle.dispose().catch(() => {})));
  }
}

export async function checkoutInHostedPage(stagehand: StagehandPage, connectUrl: string, input: CheckoutInput, origins: string[], getCredentials: () => Promise<unknown>, signal: AbortSignal) {
  const marker = `__bell_checkout_${randomUUID().replaceAll("-", "")}`;
  let bridge: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    let page: Page;
    try {
      await stagehand.evaluate(name => Reflect.set(globalThis, name, true), marker);
      bridge = await chromium.connectOverCDP(connectUrl, { timeout: 15_000 });
      const pages = bridge.contexts().flatMap(context => context.pages());
      const matches = await Promise.all(pages.map(candidate => candidate.evaluate(name => Reflect.get(globalThis, name) === true, marker).catch(() => false)));
      if (matches.filter(Boolean).length !== 1) throw new Error();
      page = pages[matches.indexOf(true)];
    } catch {
      signal.throwIfAborted();
      throw new Error("Cannot identify the existing checkout browser.");
    }
    return await submitPayment(page, input, origins, getCredentials, signal);
  } finally {
    await stagehand.evaluate(name => Reflect.deleteProperty(globalThis, name), marker).catch(() => {});
    await bridge?.close().catch(() => {});
  }
}
