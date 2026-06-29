import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getVercelSandboxCredentials } from "#execution/sandbox/bindings/vercel-credentials.js";

vi.mock("#compiled/@vercel/oidc/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiled/@vercel/oidc/index.js")>()),
  getVercelOidcToken: vi.fn(),
}));

afterEach(() => {
  vi.mocked(getVercelOidcToken).mockReset();
  vi.unstubAllEnvs();
});

describe("Vercel sandbox credentials", () => {
  it("rejects a non-object Vercel OIDC payload", async () => {
    for (const key of [
      "VERCEL_TEAM_ID",
      "VERCEL_ORG_ID",
      "VERCEL_PROJECT_ID",
      "VERCEL_OIDC_TOKEN",
      "VERCEL_TOKEN",
    ]) {
      vi.stubEnv(key, undefined);
    }
    const payload = Buffer.from("null").toString("base64url");
    vi.mocked(getVercelOidcToken).mockResolvedValue(`header.${payload}.signature`);

    await expect(getVercelSandboxCredentials({})).rejects.toThrow(
      "Invalid Vercel OIDC token: payload must be an object.",
    );
  });
});
