import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configuration, integrationIdentity, ownerOf } from "../server/onepassword/config";
import { callbackPage, onePasswordPost } from "../server/onepassword/http";
import { approvalPage } from "../server/onepassword/approval-http";
import { browserbaseLaunchOptions } from "../server/browser/browser-session";
import { requireReusableContexts } from "../server/onepassword/browser-policy";
import { validateLogin } from "../server/onepassword/login";
const key = (path = "//api.1password.com/oauth-clients/client/accounts/account/users/user") => `ops_${Buffer.from(JSON.stringify({ ver: 1, typ: "oauth_integration_key", key: "a".repeat(64), path })).toString("base64url")}`;
afterEach(() => vi.unstubAllEnvs());
describe("personal 1Password boundaries", () => {
  it("validates the complete key envelope and binds it to the registered client and API host", () => {
    expect(integrationIdentity(key(), "client")).toMatchObject({ accountId: "account", userId: "user" });
    for (const value of ["ops_bad", key("//attacker.example/oauth-clients/client/accounts/account/users/user"), key("//api.1password.com/oauth-clients/other/accounts/account/users/user")]) expect(() => integrationIdentity(value, "client")).toThrow();
  });
  it("rejects application principals and non-Linq user identities", () => {
    expect(() => ownerOf({ type: "app" })).toThrow();
    expect(() => ownerOf({ type: "user", issuer: "caller", id: "linq:user" })).toThrow();
    expect(ownerOf({ type: "user", issuer: "linq", id: "linq:user" })).toBe('["linq","linq:user"]');
  });
  it("requires an exact HTTPS callback and a canonical encryption key", () => {
    const env = { BELL_PUBLIC_URL: "https://bell.example", ONEPASSWORD_REDIRECT_URI: "https://bell.example/api/onepassword/callback", ONEPASSWORD_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"), ONEPASSWORD_CLIENT_ID: "client", ONEPASSWORD_CLIENT_SECRET: "secret", DATABASE_URL: "postgres://test" };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    expect(configuration().origin).toBe(env.BELL_PUBLIC_URL);
    vi.stubEnv("ONEPASSWORD_REDIRECT_URI", env.ONEPASSWORD_REDIRECT_URI + "?bypass=1");
    expect(configuration).toThrow();
  });
  it("serves isolated callback/approval pages without third-party scripts or caching", async () => {
    for (const response of [callbackPage(), approvalPage()]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(await response.text()).not.toMatch(/localStorage|sessionStorage|console\./);
    }
  });
  it("rejects a cross-origin callback before consuming a code", async () => {
    const capture = vi.fn();
    const service = () => ({ config: { origin: "https://bell.example" }, capture }) as never;
    const response = await onePasswordPost(new Request("https://bell.example/api/onepassword/complete", { method: "POST", headers: { origin: "https://attacker.example", "content-type": "application/json" }, body: "{}" }), "complete", service);
    expect(response.status).toBe(400);
    expect(capture).not.toHaveBeenCalled();
  });
  it("uses private non-recorded browsers and rejects reusable Contexts in personal mode", () => {
    vi.stubEnv("BROWSERBASE_1PASSWORD_EXTENSION_ID", "uploaded-extension");
    vi.stubEnv("BROWSERBASE_CONTEXT_ID", "");
    const options = browserbaseLaunchOptions("test-key");
    expect(options.extensionId).toBe("uploaded-extension");
    expect(options.browserSettings).toMatchObject({ logSession: false, recordSession: false });
    expect(options.browserSettings.context).toBeUndefined();
    expect(options.userMetadata.privateContext).toBe("true");
    expect(() => browserbaseLaunchOptions("test-key", "shared-context")).toThrow();
    expect(requireReusableContexts).toThrow();
  });
  it("rejects ambiguous success destinations and cross-origin or credential-bearing URLs", () => {
    for (const successUrl of ["http://example.com/home", "https://other.example/home", "https://example.com/login", "https://user:pass@example.com/home"]) expect(() => validateLogin({ loginUrl: "https://example.com/login", successUrl })).toThrow();
  });
});
