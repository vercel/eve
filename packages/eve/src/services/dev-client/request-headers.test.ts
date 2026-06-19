import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveDevelopmentOidcToken } from "./request-headers.js";

vi.mock("#compiled/@vercel/oidc/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiled/@vercel/oidc/index.js")>()),
  getVercelOidcToken: vi.fn(),
}));

const target = { ownerId: "team_expected", projectId: "prj_expected" } as const;

function token(claims: Record<string, string>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

afterEach(() => {
  vi.mocked(getVercelOidcToken).mockReset();
});

describe("resolveDevelopmentOidcToken", () => {
  it("returns a token whose owner and project match the verified target", async () => {
    const expected = token({ owner_id: target.ownerId, project_id: target.projectId });
    vi.mocked(getVercelOidcToken).mockResolvedValue(expected);

    await expect(resolveDevelopmentOidcToken(target)).resolves.toBe(expected);
    expect(getVercelOidcToken).toHaveBeenCalledWith({
      team: target.ownerId,
      project: target.projectId,
    });
  });

  it.each([
    ["mismatched claims", token({ owner_id: "team_other", project_id: "prj_other" })],
    ["missing claims", token({ subject: "user" })],
    ["malformed token", "not-a-jwt"],
  ])("rejects %s", async (_name, invalid) => {
    vi.mocked(getVercelOidcToken).mockResolvedValue(invalid);

    await expect(resolveDevelopmentOidcToken(target)).resolves.toBe("");
  });

  it("fails closed when token resolution throws", async () => {
    vi.mocked(getVercelOidcToken).mockRejectedValue(new Error("refresh failed"));

    await expect(resolveDevelopmentOidcToken(target)).resolves.toBe("");
  });
});
