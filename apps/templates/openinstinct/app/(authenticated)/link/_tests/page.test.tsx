import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { getLinkAccount as readLinkAccount } from "@db/services/auth/link";
import Page from "../page";

const { getLinkAccount } = vi.hoisted(() => ({
  getLinkAccount: vi.fn<typeof readLinkAccount>(),
}));

vi.mock("@db/services/auth/link", () => ({
  getLinkAccount,
  linkConfigured: () => true,
}));
vi.mock("@web/auth/request-scope", () => ({
  requireRequestScope: () => ({ userId: "better-auth:phone-user" }),
}));

beforeEach(() => {
  getLinkAccount.mockResolvedValue({ id: "wallet-account" });
});

describe("Link wallet recovery", () => {
  it("offers reauthentication and returns to the pending wallet request", async () => {
    const attempt = "6738a4d4-c973-42f4-9e4a-e8339c09687f";
    const html = renderToStaticMarkup(
      await Page({
        params: Promise.resolve({}),
        searchParams: Promise.resolve({
          error: "reauthentication_required",
          attempt,
        }),
      })
    );

    expect(html).toContain("Sign in again before disconnecting your wallet.");
    expect(html).toContain(
      `href="/sign-in?reauthenticate=true&amp;callbackUrl=%2Flink%3Fattempt%3D${attempt}"`
    );
    expect(html).not.toContain("Disconnect wallet");
  });

  it("offers a retry for failed revocation without requesting a new sign-in", async () => {
    const html = renderToStaticMarkup(
      await Page({
        params: Promise.resolve({}),
        searchParams: Promise.resolve({ error: "disconnection_failed" }),
      })
    );

    expect(html).toContain("Your wallet could not be disconnected.");
    expect(html).toContain("It is still connected. Try again shortly.");
    expect(html).toContain("Disconnect wallet");
    expect(html).not.toContain("Sign in again");
  });

  it.each(["disconnection_failed", "reauthentication_required"])(
    "shows the current disconnected state for a stale %s error",
    async (code) => {
      getLinkAccount.mockResolvedValue(undefined);
      const html = renderToStaticMarkup(
        await Page({
          params: Promise.resolve({}),
          searchParams: Promise.resolve({ error: code }),
        })
      );

      expect(html).toContain("Connect Link");
      expect(html).not.toContain("Disconnect wallet");
      expect(html).toContain("Your wallet is no longer connected.");
      expect(html).not.toContain("It is still connected.");
      expect(html).not.toContain("Sign in again");
      expect(html).not.toContain(
        "The wallet connection could not be completed"
      );
    }
  );
});
