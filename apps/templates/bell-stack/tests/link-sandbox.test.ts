import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "eve/tools";
import * as native from "@stripe/link-integrations-eve/tools";
import create from "../agent/extensions/link/tools/create_spend_request";
import retrieve from "../agent/extensions/link/tools/retrieve_spend_request";
import update from "../agent/extensions/link/tools/update_spend_request";
import cancel from "../agent/extensions/link/tools/cancel_spend_request";
import approval from "../agent/extensions/link/tools/request_spend_approval";
import list from "../agent/extensions/link/tools/list_spend_requests";
import methods from "../agent/extensions/link/tools/list_payment_methods";
import addresses from "../agent/extensions/link/tools/list_shipping_addresses";
import profile from "../agent/extensions/link/tools/retrieve_user_info";
import disconnect from "../agent/tools/link_disconnect";
import { createLinkAuth, freshLinkContext } from "../agent/lib/link-auth";
import { linkCallback } from "../server/link/callback";
import { assertSandboxRequest, rememberSandboxRequest, sandboxPurchase } from "../server/link/sandbox";
import { quarantineBrowser, withBrowserPrivacyLock } from "../server/browser/privacy-lock";

const principal = { type: "user" as const, issuer: "linq", id: "linq:sandbox-operator" };
const context = { session: { id: "sandbox-session", auth: { current: { principalType: "user", principalId: principal.id, issuer: "linq", authenticator: "linq-message" } } }, abortSignal: new AbortController().signal, getToken: vi.fn(), requireAuth: vi.fn() } as unknown as ToolContext;
const purchase = { credential_type: "card" as const, amount: 100, currency: "usd", request_approval: true, test: false, merchant_name: "Fixture", merchant_url: "https://merchant.invalid", context: "The operator requested one synthetic fixture item for exactly one dollar, including all tax and shipping, solely to test this integration.", idempotency_key: "existing-live-key" };
const metadata = (id = `spend_${randomUUID()}`) => ({ id, status: "approved", amount: 100, currency: "usd", merchant_url: purchase.merchant_url, created_at: "now", updated_at: "now" });
beforeEach(() => {
  vi.stubEnv("LINK_SANDBOX", "1"); vi.stubEnv("LINK_SANDBOX_ACCESS_TOKEN", "synthetic-process-token"); vi.stubEnv("LINK_SANDBOX_PRINCIPAL_ID", principal.id);
  for (const name of ["DATABASE_URL", "LINK_CLIENT_ID", "LINK_CLIENT_SECRET", "LINK_TOKEN_ENCRYPTION_KEY"]) vi.stubEnv(name, "");
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe("database-free Link sandbox", () => {
  it("forces test purchases and isolates idempotency keys from existing real requests", async () => {
    const result = metadata();
    const execute = vi.spyOn(native.create_spend_request, "execute").mockResolvedValue(result as never);
    expect(await create.execute(purchase, context)).toEqual({ ...result, test: true });
    const input = execute.mock.calls[0][0];
    expect(input.test).toBe(true); expect(input.idempotency_key).not.toBe(purchase.idempotency_key);
    expect(sandboxPurchase(purchase).idempotency_key).toBe(input.idempotency_key);
    expect(sandboxPurchase({ ...purchase, idempotency_key: "other" }).idempotency_key).not.toBe(input.idempotency_key);
    expect(() => assertSandboxRequest(result.id)).not.toThrow();
    expect(create.approval).toBe(native.create_spend_request.approval);
  });
  it("exposes only current test requests, without caching credentials in Eve", async () => {
    const result = metadata(); rememberSandboxRequest(result.id);
    vi.spyOn(native.retrieve_spend_request, "execute").mockImplementation(async (_input, ctx) => {
      expect(await ctx.getToken({ getToken: vi.fn() })).toEqual({ token: "synthetic-process-token" });
      return { ...result, card: { number: "synthetic-card" } } as never;
    });
    expect(await retrieve.execute({ id: result.id }, context)).toEqual({ ...result, test: true });
    vi.spyOn(native.list_spend_requests, "execute").mockResolvedValue([metadata("spend_real"), result] as never);
    expect(await list.execute({}, context)).toEqual([{ ...result, test: true }]);
    expect(context.getToken).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/synthetic-process-token|synthetic-card/);
  });
  it("rejects existing or forgotten request IDs before any native mutation or retrieval", async () => {
    for (const [tool, original, input] of [[retrieve, native.retrieve_spend_request, { id: "spend_real" }], [update, native.update_spend_request, { id: "spend_real", amount: 100 }], [cancel, native.cancel_spend_request, { id: "spend_real" }], [approval, native.request_spend_approval, { id: "spend_real" }]] as const) {
      const execute = vi.spyOn(original, "execute");
      await expect(tool.execute(input as never, context)).rejects.toThrow("test requests created by this process");
      expect(execute).not.toHaveBeenCalled();
    }
  });
  it("rejects other senders, anonymous callers, and a missing runtime token", async () => {
    const execute = vi.spyOn(native.create_spend_request, "execute");
    vi.stubEnv("LINK_SANDBOX_PRINCIPAL_ID", "linq:another-sender");
    await expect(create.execute(purchase, context)).rejects.toThrow("configured Link sandbox operator");
    expect(() => freshLinkContext({ ...context, session: { auth: { current: undefined } } } as never, undefined, "create")).toThrow();
    vi.stubEnv("LINK_SANDBOX_PRINCIPAL_ID", principal.id); vi.stubEnv("LINK_SANDBOX_ACCESS_TOKEN", "");
    await expect(create.execute(purchase, context)).rejects.toThrow("LINK_SANDBOX_ACCESS_TOKEN");
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not fetch saved wallet profiles, payment methods, or addresses", async () => {
    for (const [tool, original] of [[methods, native.list_payment_methods], [addresses, native.list_shipping_addresses], [profile, native.retrieve_user_info]] as const) {
      const execute = vi.spyOn(original, "execute");
      await expect(Promise.resolve().then(() => tool.execute({}, context))).rejects.toThrow("not saved wallet details");
      expect(execute).not.toHaveBeenCalled();
    }
  });
  it("never opens the OAuth store or callback in sandbox mode", async () => {
    const service = vi.fn(); vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(createLinkAuth(service).getToken({ principal, connection: { url: "" } })).rejects.toThrow();
    expect((await linkCallback(new Request("https://bell.invalid/api/link/oauth/callback?state=x&code=y"), service)).status).toBe(404);
    await expect(disconnect.execute({}, context)).rejects.toThrow("no saved wallet connection");
    expect(service).not.toHaveBeenCalled();
  });
  it("serializes readers behind private entry and keeps an interrupted browser quarantined", async () => {
    const id = randomUUID(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const payment = withBrowserPrivacyLock(id, async () => { entered(); await gate; await quarantineBrowser(); throw new Error("interrupted"); });
    const failure = expect(payment).rejects.toThrow("interrupted"); await started;
    const read = expect(withBrowserPrivacyLock(id, async () => "private snapshot")).rejects.toThrow("Payment details may remain");
    release(); await failure; await read;
    expect(await withBrowserPrivacyLock(randomUUID(), async () => "safe")).toBe("safe");
  });
  it("refuses recovered browsers and loses test-request access after process state is replaced", async () => {
    const id = randomUUID(); rememberSandboxRequest(id); expect(() => assertSandboxRequest(id)).not.toThrow();
    vi.resetModules();
    const restarted = await import("../server/link/sandbox");
    expect(() => restarted.assertSandboxRequest(id)).toThrow("test requests created by this process");
    const privacy = await import("../server/browser/privacy-lock");
    const operation = vi.fn(async () => "private snapshot");
    await expect(privacy.withBrowserPrivacyLock(randomUUID(), operation, undefined, true)).rejects.toThrow("cannot recover");
    expect(operation).not.toHaveBeenCalled();
  });
  it("preserves real Link inputs when sandbox mode is disabled", () => {
    vi.stubEnv("LINK_SANDBOX", "0"); expect(sandboxPurchase(purchase)).toBe(purchase);
    expect(() => assertSandboxRequest("existing_real_request")).not.toThrow();
  });
});
