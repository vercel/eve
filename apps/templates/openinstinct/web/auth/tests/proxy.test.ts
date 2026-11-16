import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthSession } from "@db/services/auth/session";
import { config, proxy } from "../../../proxy";

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn<typeof getAuthSession>(),
}));

vi.mock("@db/services/auth/session", () => ({
  getAuthSession: mocks.getAuthSession,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthSession.mockResolvedValue(null);
});

describe("auth proxy matcher", () => {
  it.each([
    "/icon.svg",
    "/icon.svg?icon.hash.svg",
    "/apple-icon.png",
    "/apple-icon.png?apple-icon.hash.png",
    "/opengraph-image.png",
    "/opengraph-image.png?opengraph-image.hash.png",
  ])("does not match public branding asset %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(
      false
    );
  });

  it.each([
    "/icon.svg/private",
    "/apple-icon.png/private",
    "/opengraph-image.png/private",
  ])("continues to match paths beneath a branding filename %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(
      true
    );
  });

  it("does not match public fonts", () => {
    expect(
      unstable_doesMiddlewareMatch({
        config,
        nextConfig: {},
        url: "/fonts/vault-variable.woff2",
      })
    ).toBe(false);
  });

  it("continues to match protected application routes", () => {
    expect(
      unstable_doesMiddlewareMatch({
        config,
        nextConfig: {},
        url: "/vault",
      })
    ).toBe(true);
  });

  it("leaves scheduled-run authorization to the Eve channel", async () => {
    const response = await proxy(
      new NextRequest("https://example.com/internal/scheduled-run/start")
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(getAuthSession).not.toHaveBeenCalled();
  });

  it("allows the schedule dispatcher without a browser session in development", async () => {
    const response = await proxy(
      new NextRequest("http://localhost:3000/eve/v1/dev/schedules/dynamic")
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(getAuthSession).not.toHaveBeenCalled();
  });
});
