import { describe, expect, it } from "vitest";

import { defineInteractiveAuthorization } from "#runtime/connections/types.js";

describe("defineInteractiveAuthorization", () => {
  it("sets principalType to user", () => {
    const auth = defineInteractiveAuthorization({
      getToken: async () => ({ token: "cached" }),
      startAuthorization: async () => ({
        challenge: { url: "https://idp.example/auth" },
        resume: { authorizationId: "abc" },
      }),
      completeAuthorization: async () => ({ token: "fresh" }),
    });

    expect(auth.principalType).toBe("user");
  });

  it("preserves all callback references", () => {
    const getToken = async () => ({ token: "cached" });
    const startAuthorization = async () => ({
      challenge: { url: "https://idp.example/auth" } as const,
      resume: { id: "x" },
    });
    const completeAuthorization = async () => ({ token: "fresh" });

    const auth = defineInteractiveAuthorization({
      getToken,
      startAuthorization,
      completeAuthorization,
    });

    expect(auth.getToken).toBe(getToken);
    expect(auth.startAuthorization).toBe(startAuthorization);
    expect(auth.completeAuthorization).toBe(completeAuthorization);
  });

  it("infers resume type from startAuthorization to completeAuthorization", () => {
    const auth = defineInteractiveAuthorization<{ verifier: string; nonce: number }>({
      getToken: async () => ({ token: "cached" }),
      startAuthorization: async () => ({
        challenge: { url: "https://idp.example/auth" },
        resume: { verifier: "pkce-code", nonce: 42 },
      }),
      completeAuthorization: async ({ resume }) => {
        const _verifier: string = resume!.verifier;
        const _nonce: number = resume!.nonce;
        return { token: `${_verifier}-${_nonce}` };
      },
    });

    expect(auth.principalType).toBe("user");
  });
});
