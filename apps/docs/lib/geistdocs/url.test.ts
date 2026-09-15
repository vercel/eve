import { afterEach, describe, expect, it, vi } from "vitest";
import { getSiteOrigin } from "./url";

const SITE_ENV = "NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL";

afterEach(() => vi.unstubAllEnvs());

describe("getSiteOrigin", () => {
  it("preserves a configured HTTP origin", () => {
    vi.stubEnv(SITE_ENV, "http://docs.eve.localhost");

    expect(getSiteOrigin()).toBe("http://docs.eve.localhost");
  });

  it("adds HTTPS to a configured deployment host", () => {
    vi.stubEnv(SITE_ENV, "eve.dev");

    expect(getSiteOrigin()).toBe("https://eve.dev");
  });

  it("rejects a non-HTTP URL", () => {
    vi.stubEnv(SITE_ENV, "file:///tmp/eve-docs");

    expect(() => getSiteOrigin()).toThrow("Unsupported site URL protocol: file:");
  });
});
