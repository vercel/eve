import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import {
  authorizeResendMarketplaceSetup,
  createResendApiKey,
  deleteResendApiKey,
  type MarketplaceOAuthDeps,
} from "./marketplace-oauth.js";

function effects(outputs: Array<{ ok: boolean; stdout: string }>): MarketplaceOAuthDeps {
  return {
    fetch: vi.fn(),
    runVercelCaptureStdout: vi.fn(async () => outputs.shift() ?? { ok: true, stdout: "{}" }),
  };
}

describe("Resend Marketplace setup OAuth", () => {
  it("creates and deletes a dedicated full-access API key", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "key_1", token: "re_dedicated" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      createResendApiKey({
        accessToken: "oauth_secret",
        name: "eve · weather",
        deps: { fetch },
      }),
    ).resolves.toEqual({ id: "key_1", token: "re_dedicated" });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ name: "eve · weather", permission: "full_access" }),
    );
    await deleteResendApiKey({
      accessToken: "oauth_secret",
      id: "key_1",
      deps: { fetch },
    });
    expect(fetch.mock.calls[1]?.[0]).toBe("https://api.resend.com/api-keys/key_1");
  });
  it("authorizes full_access and removes the temporary connector after cleanup", async () => {
    const deps = effects([
      {
        ok: true,
        stdout: JSON.stringify({
          id: "scl_setup",
          uid: "oauth/eve-resend-setup",
          supportedSubjectTypes: ["user"],
        }),
      },
      { ok: true, stdout: JSON.stringify({ token: "oauth_secret" }) },
      { ok: true, stdout: JSON.stringify({ deleted: 1 }) },
      { ok: true, stdout: JSON.stringify({ removed: true }) },
    ]);

    const authorization = await authorizeResendMarketplaceSetup({
      log: createFakePrompter().prompter.log,
      projectRoot: "/project",
      orgId: "team",
      deps,
    });
    expect(authorization.accessToken).toBe("oauth_secret");
    await authorization.cleanup();

    const calls = vi.mocked(deps.runVercelCaptureStdout).mock.calls.map((call) => call[0]);
    expect(calls[1]).toEqual(
      expect.arrayContaining([
        "connect",
        "token",
        "oauth/eve-resend-setup",
        "--scopes",
        "full_access",
        "--yes",
      ]),
    );
    expect(calls[2]).toEqual(
      expect.arrayContaining(["connect", "revoke-tokens", "--my-tokens", "--yes"]),
    );
    expect(calls[3]).toEqual(
      expect.arrayContaining(["connect", "remove", "--disconnect-all", "--yes"]),
    );
  });
});
