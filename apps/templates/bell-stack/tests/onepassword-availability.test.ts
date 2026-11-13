import type { ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ service: vi.fn(), disconnect: vi.fn() }));
vi.mock("../server/onepassword/oauth", () => ({ getOnePassword: mocks.service }));
import connect from "../agent/tools/onepassword_connect";
import login from "../agent/tools/onepassword_login";
import status from "../agent/tools/onepassword_status";
import disconnect from "../agent/tools/onepassword_disconnect";
import { onePasswordGet, onePasswordPost } from "../server/onepassword/http";
import { browserbaseLaunchOptions } from "../server/browser/browser-session";
import { requireReusableContexts } from "../server/onepassword/browser-policy";

describe("personal 1Password rollout", () => {
  let ctx: ToolContext;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ONEPASSWORD_ENABLED", undefined);
    vi.stubEnv("BROWSERBASE_1PASSWORD_EXTENSION_ID", "");
    vi.stubEnv("BROWSERBASE_CONTEXT_ID", "");
    mocks.service.mockReturnValue({ disconnect: mocks.disconnect });
    ctx = { session: { id: "conversation", auth: { current: { principalType: "user", authenticator: "linq-message", issuer: "linq", principalId: "linq:sender" } } }, getToken: vi.fn() } as unknown as ToolContext;
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each([undefined, "", "false", "0", "TRUE"])("blocks consent and login before side effects when enabled=%s", async enabled => {
    vi.stubEnv("ONEPASSWORD_ENABLED", enabled);
    vi.stubEnv("ONEPASSWORD_CLIENT_ID", "saved-client");
    vi.stubEnv("ONEPASSWORD_CLIENT_SECRET", "saved-secret");
    await expect(connect.execute({}, ctx)).rejects.toThrow("personal_1password_disabled");
    await expect(login.execute({ loginUrl: "https://example.com/login", successUrl: "https://example.com/home" }, ctx)).rejects.toThrow("personal_1password_disabled");
    expect(ctx.getToken).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it("reports disabled without requiring a database or provider configuration", async () => {
    expect(await status.execute({}, ctx)).toEqual({ status: "disabled" });
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it("rejects connection-start links without calling the provider or setting cookies", async () => {
    const service = vi.fn();
    const response = await onePasswordGet(new Request(`https://bell.example/api/onepassword/start?state=${"s".repeat(43)}`), "start", service);
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(service).not.toHaveBeenCalled();
  });
  it("keeps disconnect and previously issued callback completion available", async () => {
    mocks.disconnect.mockResolvedValue({ status: "disconnected" });
    expect(await disconnect.execute({}, ctx)).toEqual({ status: "disconnected" });
    expect(mocks.disconnect).toHaveBeenCalledWith({ type: "user", issuer: "linq", id: "linq:sender" });
    const capture = vi.fn().mockResolvedValue("https://bell.example/eve/v1/connections/op/callback/id/hook");
    const response = await onePasswordPost(new Request("https://bell.example/api/onepassword/complete", { method: "POST", headers: { origin: "https://bell.example", "content-type": "application/json" }, body: JSON.stringify({ state: "s".repeat(43), code: "issued-code" }) }), "complete", () => ({ config: { origin: "https://bell.example" }, capture }) as never);
    expect(response.status).toBe(200);
    expect(capture).toHaveBeenCalledOnce();
  });
  it("preserves ordinary browsing and private-context protections", () => {
    const options = browserbaseLaunchOptions("test-key");
    expect(options.extensionId).toBeUndefined();
    expect(options.browserSettings).toMatchObject({ logSession: false, recordSession: false });
    expect(requireReusableContexts).not.toThrow();
    vi.stubEnv("BROWSERBASE_1PASSWORD_EXTENSION_ID", "previous-private-extension");
    expect(requireReusableContexts).toThrow();
  });
});
