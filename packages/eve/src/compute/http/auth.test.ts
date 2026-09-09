import { describe, expect, it } from "vitest";

import { createComputeAuthenticator, hashComputeCredential } from "#compute/http/auth.js";

const namespaceId = "00000000-0000-4000-8000-000000000001";

describe("compute bearer authentication", () => {
  const authenticator = createComputeAuthenticator([
    {
      credentialHash: hashComputeCredential("0123456789abcdef0123456789abcdef"),
      namespaceId,
      permissions: ["send"],
      principalId: "alice",
    },
  ]);

  it("authorizes the exact namespace and permission", async () => {
    const request = new Request("https://compute.test", {
      headers: {
        authorization: "Bearer 0123456789abcdef0123456789abcdef",
      },
    });
    await expect(authenticator.authenticate(request, namespaceId, "send")).resolves.toEqual({
      principalId: "alice",
    });
    await expect(authenticator.authenticate(request, namespaceId, "read")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("does not treat the token as a cross-namespace capability", async () => {
    const request = new Request("https://compute.test", {
      headers: {
        authorization: "Bearer 0123456789abcdef0123456789abcdef",
      },
    });
    await expect(
      authenticator.authenticate(request, "00000000-0000-4000-8000-000000000002", "send"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
