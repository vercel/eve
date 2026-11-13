import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { getAuthSession } from "@db/services/auth/session";
import { proxy } from "../proxy";

const auth = vi.hoisted(() => ({ getSession: vi.fn<typeof getAuthSession>() }));
vi.mock("@db/services/auth/session", () => ({
  getAuthSession: auth.getSession,
}));

describe("contact download proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.getSession.mockResolvedValue(null);
  });

  it("lets the signed contact route validate provider downloads without a cookie", async () => {
    const response = await proxy(
      new NextRequest(
        "https://example.com/contacts/openinstinct.vcf?signature=opaque"
      )
    );
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it.each([
    "/contacts/private.vcf",
    "/contacts/openinstinct.vcf/other",
    "/vault",
  ])("keeps %s authenticated", async (path) => {
    const response = await proxy(new NextRequest(`https://example.com${path}`));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `https://example.com/sign-in?callbackUrl=${encodeURIComponent(path)}`
    );
  });
});
