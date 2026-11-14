import type { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@web/auth/request-scope";
import { createHTTPContext } from "./http-context";

describe("createHTTPContext", () => {
  it("blocks cross-origin mutations", async () => {
    const getScope = vi.fn<() => Promise<never>>();

    await expect(
      createHTTPContext(
        new Request("https://example.com/api/trpc", {
          headers: { Origin: "https://attacker.example" },
          method: "POST",
        }),
        getScope
      )
    ).rejects.toEqual(
      expect.objectContaining<Partial<TRPCError>>({
        code: "FORBIDDEN",
      })
    );
    expect(getScope).not.toHaveBeenCalled();
  });

  it("maps a missing session to an unauthorized tRPC error", async () => {
    const getScope = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new UnauthenticatedError());

    await expect(
      createHTTPContext(new Request("https://example.com/api/trpc"), getScope)
    ).rejects.toEqual(
      expect.objectContaining<Partial<TRPCError>>({
        code: "UNAUTHORIZED",
      })
    );
  });

  it("preserves unexpected authentication infrastructure failures", async () => {
    const failure = new Error("database unavailable");
    const getScope = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    await expect(
      createHTTPContext(new Request("https://example.com/api/trpc"), getScope)
    ).rejects.toBe(failure);
  });
});
