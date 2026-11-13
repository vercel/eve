import Browserbase from "@browserbasehq/sdk";
import { chromium, type Worker, type Page } from "playwright-core";
import { z } from "zod";
import { failed } from "./config";

type Result = { success: boolean; result?: unknown; error?: { code?: string } };
type ExtensionGlobal = typeof globalThis & {
  chrome: { runtime: { getManifest(): { short_name?: string; version: string } }; tabs: { query(query: object): Promise<{ id?: number; url?: string }[]> } };
  api: { initialization: { v1: { whenSettled(): Promise<string> } }; agenticMode: { v1: { enable(): Promise<Result> } }; agenticAutofill: { v1: Record<string, (args: Record<string, unknown>) => Promise<Result>> } };
};
export class ExtensionError extends Error {
  constructor(readonly code: "rateLimitExceeded" | "timeout" | "networkError" | "operation_failed") { super(`1Password ${code}`); }
}
export function unwrap(value: unknown): unknown {
  const parsed = z.object({ success: z.boolean(), result: z.unknown().optional(), error: z.object({ code: z.string().optional() }).optional() }).safeParse(value);
  if (!parsed.success) return failed("invalid_extension_response");
  if (!parsed.data.success) {
    const code = parsed.data.error?.code;
    throw new ExtensionError(code === "rateLimitExceeded" || code === "timeout" || code === "networkError" ? code : "operation_failed");
  }
  return parsed.data.result;
}
async function workerReady(worker: Worker): Promise<boolean> {
  return worker.evaluate(async () => {
    const env = globalThis as ExtensionGlobal;
    if (env.chrome.runtime.getManifest().short_name !== "1Password") return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([env.api?.initialization?.v1?.whenSettled(), new Promise(resolve => { timer = setTimeout(() => resolve("timeout"), 15_000); })]);
      if (ready !== "ready" || !["createAccessRequest", "getAccessRequestStatus", "fillCredential"].every(method => typeof env.api?.agenticAutofill?.v1?.[method] === "function")) return false;
      return (await env.api.agenticMode.v1.enable()).success;
    } finally { clearTimeout(timer); }
  });
}
export async function withExtension<T>(connectUrl: string, operation: (worker: Worker, pages: Page[]) => Promise<T>): Promise<T> {
  const browser = await chromium.connectOverCDP(connectUrl, { timeout: 15_000 });
  try {
    const context = browser.contexts()[0];
    if (!context) return failed("browser_context_missing");
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      for (const worker of context.serviceWorkers()) {
        if (!worker.url().startsWith("chrome-extension://")) continue;
        if (await workerReady(worker).catch(() => false)) return await operation(worker, context.pages());
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return failed("agentic_autofill_extension_unavailable");
  } finally { await browser.close(); }
}
async function call(worker: Worker, method: string, accessToken: string, integrationKey: string, args: Record<string, unknown>) {
  const value = await worker.evaluate(async ({ method, accessToken, integrationKey, args }) => {
    const env = globalThis as ExtensionGlobal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([env.api.agenticAutofill.v1[method]({ ...args, accessToken, integrationKey }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("1Password timed out")), 20_000); })]);
    } finally { clearTimeout(timer); }
  }, { method, accessToken, integrationKey, args });
  return unwrap(value);
}
const createdSchema = z.object({ appLink: z.string().min(1).max(16384), accessRequest: z.object({ id: z.string().min(1), entries: z.array(z.object({ id: z.string().min(1) })).length(1) }) });
export async function createAccess(connectUrl: string, accessToken: string, integrationKey: string, website: string) {
  return withExtension(connectUrl, async worker => {
    const value = createdSchema.parse(await call(worker, "createAccessRequest", accessToken, integrationKey, { requests: { version: 2, goal: "Sign in for this Bell conversation", entries: [{ type: "login", parameters: { website }, reason: "Sign in to continue the requested task" }] } }));
    const link = new URL(value.appLink);
    if (!["https:", "onepassword:"].includes(link.protocol) || link.username || link.password) return failed("invalid_approval_link");
    return { requestId: value.accessRequest.id, entryId: value.accessRequest.entries[0].id, appLink: value.appLink };
  });
}
export async function checkAccess(browserSessionId: string, accessToken: string, integrationKey: string, requestId: string) {
  const session = await new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY }).sessions.retrieve(browserSessionId);
  if (session.userMetadata?.onepasswordExtension !== process.env.BROWSERBASE_1PASSWORD_EXTENSION_ID || session.userMetadata?.networkLogging !== "false" || session.userMetadata?.sessionRecording !== "false" || session.userMetadata?.privateContext !== "true") return failed("unsafe_browser_session");
  if (!session.connectUrl) return failed("browser_connection_missing");
  return withExtension(session.connectUrl, async worker => z.object({ state: z.string(), resolved: z.array(z.object({ entryId: z.string(), reference: z.string().min(1) })).optional() }).parse(await call(worker, "getAccessRequestStatus", accessToken, integrationKey, { accessRequestUUID: requestId })));
}
export async function fillAccess(connectUrl: string, accessToken: string, integrationKey: string, reference: string, loginUrl: string, successUrl: string): Promise<void> {
  await withExtension(connectUrl, async (worker, pages) => {
    const matches = pages.filter(page => page.url() === loginUrl);
    if (matches.length !== 1) return failed("login_page_changed");
    const tabId = await worker.evaluate(async url => {
      const tabs = (await (globalThis as ExtensionGlobal).chrome.tabs.query({})).filter(tab => tab.url === url);
      return tabs.length === 1 ? tabs[0].id : undefined;
    }, loginUrl);
    if (tabId === undefined) return failed("login_tab_ambiguous");
    const result = z.object({ status: z.literal("fill_submitted") }).parse(await call(worker, "fillCredential", accessToken, integrationKey, { resourcePath: reference, tabId }));
    if (result.status !== "fill_submitted") return failed("fill_failed");
    const expected = new URL(successUrl);
    await matches[0].waitForURL(url => url.origin === expected.origin && url.pathname === expected.pathname, { timeout: 20_000, waitUntil: "domcontentloaded" });
  });
}
