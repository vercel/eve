import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDevelopmentRequestHeadersAsync,
  VERCEL_OIDC_TOKEN_HEADER,
  VERCEL_PROTECTION_BYPASS_HEADER,
  VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER,
} from "../src/services/dev-client/request-headers.js";

vi.mock("#compiled/@vercel/oidc/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("#compiled/@vercel/oidc/index.js")>();

  return {
    ...original,
    getVercelOidcToken: vi.fn(),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(getVercelOidcToken).mockReset();
  vi.restoreAllMocks();
});

describe("createDevelopmentRequestHeadersAsync", () => {
  it("adds the Vercel protection bypass header for preview-scoped eve routes", async () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "secret_123");
    vi.mocked(getVercelOidcToken).mockRejectedValue(new Error("not linked"));

    const headers = await createDevelopmentRequestHeadersAsync({
      headers: {
        "content-type": "application/json",
      },
      resourceUrl: new URL("https://example.com/preview/eve/v1"),
    });

    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get(VERCEL_PROTECTION_BYPASS_HEADER)).toBe("secret_123");
  });

  it("skips the bypass header for non-eve routes", async () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "secret_123");

    const headers = await createDevelopmentRequestHeadersAsync({
      resourceUrl: new URL("https://example.com/preview/api/messages"),
    });

    expect(headers.has(VERCEL_PROTECTION_BYPASS_HEADER)).toBe(false);
  });

  it("prefers the forwarded Vercel runtime OIDC header when Authorization is absent", async () => {
    const headers = await createDevelopmentRequestHeadersAsync({
      headers: {
        [VERCEL_OIDC_TOKEN_HEADER]: "runtime_token_123",
      },
      resourceUrl: new URL("https://example.com/eve/v1"),
    });

    expect(headers.get("authorization")).toBe("Bearer runtime_token_123");
  });

  it("preserves explicit Authorization headers when a runtime OIDC header is also present", async () => {
    const headers = await createDevelopmentRequestHeadersAsync({
      headers: {
        authorization: "Basic dGVzdDpzZWNyZXQ=",
        [VERCEL_OIDC_TOKEN_HEADER]: "runtime_token_123",
      },
      resourceUrl: new URL("https://example.com/eve/v1"),
    });

    expect(headers.get("authorization")).toBe("Basic dGVzdDpzZWNyZXQ=");
    expect(headers.get(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER)).toBe("runtime_token_123");
  });

  it("skips the OIDC bearer for 127.0.0.1 targets too", async () => {
    vi.mocked(getVercelOidcToken).mockResolvedValue("oidc_token_123");

    const headers = await createDevelopmentRequestHeadersAsync({
      resourceUrl: new URL("http://127.0.0.1:3000/eve/v1"),
    });

    expect(headers.has("authorization")).toBe(false);
  });

  it("hydrates Authorization from the linked local Vercel project when needed", async () => {
    vi.mocked(getVercelOidcToken).mockResolvedValue("oidc_token_456");

    const headers = await createDevelopmentRequestHeadersAsync({
      resourceUrl: new URL("https://example.com/eve/v1"),
    });

    expect(headers.get("authorization")).toBe("Bearer oidc_token_456");
    expect(getVercelOidcToken).toHaveBeenCalledTimes(1);
  });

  it("attaches the trusted OIDC IDP bypass header from a linked Vercel project", async () => {
    vi.mocked(getVercelOidcToken).mockResolvedValue("oidc_token_456");

    const headers = await createDevelopmentRequestHeadersAsync({
      resourceUrl: new URL("https://example.com/eve/v1"),
    });

    expect(headers.get(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER)).toBe("oidc_token_456");
  });

  it("prefers the refreshed local Vercel OIDC token over the existing environment value", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", "stale_token");
    vi.mocked(getVercelOidcToken).mockResolvedValue("fresh_token");

    const headers = await createDevelopmentRequestHeadersAsync({
      resourceUrl: new URL("https://example.com/eve/v1"),
    });

    expect(headers.get("authorization")).toBe("Bearer fresh_token");
  });

  it("keeps explicit Authorization headers untouched while still attaching the OIDC bypass", async () => {
    vi.mocked(getVercelOidcToken).mockResolvedValue("oidc_token_456");

    const headers = await createDevelopmentRequestHeadersAsync({
      headers: {
        authorization: "Basic dGVzdDpzZWNyZXQ=",
      },
      resourceUrl: new URL("https://example.com/eve/v1"),
    });

    expect(headers.get("authorization")).toBe("Basic dGVzdDpzZWNyZXQ=");
    expect(headers.get(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER)).toBe("oidc_token_456");
    expect(getVercelOidcToken).toHaveBeenCalledTimes(1);
  });

  it("falls back to unauthenticated headers when local OIDC resolution is unavailable", async () => {
    vi.mocked(getVercelOidcToken).mockRejectedValue(new Error("not linked"));

    const headers = await createDevelopmentRequestHeadersAsync({
      resourceUrl: new URL("https://example.com/eve/v1"),
    });

    expect(headers.has("authorization")).toBe(false);
  });

  it("does not call getVercelOidcToken when the target eve route is on localhost", async () => {
    vi.mocked(getVercelOidcToken).mockResolvedValue("oidc_token_456");

    const headers = await createDevelopmentRequestHeadersAsync({
      resourceUrl: new URL("http://localhost:3000/eve/v1"),
    });

    expect(headers.has("authorization")).toBe(false);
    expect(headers.has(VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER)).toBe(false);
    expect(getVercelOidcToken).not.toHaveBeenCalled();
  });
});
