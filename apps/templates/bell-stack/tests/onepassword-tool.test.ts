import type { ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fill: vi.fn(), run: vi.fn(), closeRuntime: vi.fn(), mark: vi.fn(), extensionFill: vi.fn(), create: vi.fn() }));
vi.mock("../server/onepassword/login", async importOriginal => ({ ...await importOriginal<object>(), getOnePasswordLogin: () => ({ fill: mocks.fill }) }));
vi.mock("../server/onepassword/browser-policy", () => ({ markSecretFill: mocks.mark }));
vi.mock("../server/onepassword/extension", () => ({ createAccess: mocks.create, fillAccess: mocks.extensionFill }));
vi.mock("../agent/lib/browser-runtime", () => ({ runBrowserOperation: mocks.run, closeBrowserRuntime: mocks.closeRuntime, saveBrowserRuntime: vi.fn(), runCancelableBrowserWork: (_id: string, _signal: AbortSignal, operation: () => Promise<unknown>) => operation() }));
import tool from "../agent/tools/onepassword_login";
const input = { loginUrl: "https://example.com/login", successUrl: "https://example.com/home" };
describe("personal login tool orchestration", () => {
  let ctx: ToolContext, browser: { withHostedPage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ONEPASSWORD_ENABLED", "true");
    vi.stubEnv("BROWSERBASE_1PASSWORD_EXTENSION_ID", "synthetic-extension");
    ctx = { session: { id: "conversation", auth: { current: { principalType: "user", authenticator: "linq-message", issuer: "linq", principalId: "linq:sender" } } }, callId: "call", abortSignal: new AbortController().signal, getToken: vi.fn(async () => ({ token: "opaque-marker" })) } as unknown as ToolContext;
    browser = { withHostedPage: vi.fn(async (_signal, operation) => operation({ url: async () => input.loginUrl }, "private-cdp-url", "browser-id")), close: vi.fn() };
    mocks.run.mockImplementation(async (_id, operation) => ({ result: await operation(browser), workbench: { browser: { sessionId: "browser-id" } } }));
    mocks.extensionFill.mockResolvedValue(undefined);
    mocks.fill.mockImplementation(async (_principal, _id, _session, operation) => {
      await operation({ accessToken: "private-access", integrationKey: "private-key" }, { ...input, browserSessionId: "browser-id", reference: "private-reference" });
      return { status: "destination_verified", url: input.successUrl };
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("returns only destination status after filling and clears the guard only after success", async () => {
    const result = await tool.execute(input, ctx);
    expect(result).toEqual({ status: "destination_verified", url: input.successUrl });
    expect(JSON.stringify(result)).not.toMatch(/private-/);
    expect(mocks.mark.mock.calls).toEqual([[true], [false]]);
    expect(mocks.extensionFill).toHaveBeenCalledWith("private-cdp-url", "private-access", "private-key", "private-reference", input.loginUrl, input.successUrl);
  });
  it("closes a failed fill while the operation is still locked and leaves the durable guard set", async () => {
    mocks.extensionFill.mockRejectedValueOnce(new Error("provider error with private-access"));
    await expect(tool.execute(input, ctx)).rejects.toThrow("login_not_verified_browser_closed");
    expect(mocks.mark.mock.calls).toEqual([[true]]);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(mocks.closeRuntime).toHaveBeenCalledOnce();
  });
  it("does not report success when the runtime returns a CAPTCHA handoff without running the fill", async () => {
    mocks.run.mockResolvedValueOnce({ result: { status: "waiting_for_user", reason: "captcha" }, workbench: {} });
    await expect(tool.execute(input, ctx)).rejects.toThrow();
    expect(mocks.extensionFill).not.toHaveBeenCalled();
  });
  it("rejects a replacement browser instead of moving a grant into another session", async () => {
    browser.withHostedPage.mockImplementation(async (_signal, operation) => operation({ url: async () => input.loginUrl }, "private-cdp-url", "different-browser"));
    await expect(tool.execute(input, ctx)).rejects.toThrow();
    expect(mocks.extensionFill).not.toHaveBeenCalled();
  });
  it("rejects an operator session before requesting personal authorization", async () => {
    ctx = { ...ctx, session: { ...ctx.session, auth: { current: { principalType: "user", authenticator: "http-basic", issuer: "bell", principalId: "operator" } } } } as unknown as ToolContext;
    await expect(tool.execute(input, ctx)).rejects.toThrow("authenticated_sender_required");
    expect(ctx.getToken).not.toHaveBeenCalled();
  });
});
