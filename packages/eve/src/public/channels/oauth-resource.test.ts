import { describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import {
  oauthResource,
  readOAuthResourceOptions,
  routeAuth,
  type AuthFn,
} from "#public/channels/auth.js";

const principal: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "user-1",
  principalType: "user",
};

describe("oauthResource", () => {
  it("preserves the ordered auth walk and attaches non-enumerable metadata", async () => {
    const skip = vi.fn<AuthFn<Request>>(() => null);
    const accept = vi.fn<AuthFn<Request>>(() => principal);
    const auth = oauthResource([skip, accept], {
      issuer: "https://auth.example",
      scopes: ["agent:invoke"],
    });

    await expect(routeAuth(new Request("https://agent.example/mcp"), auth)).resolves.toBe(
      principal,
    );
    expect(skip).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledOnce();
    expect(Object.keys(auth)).toEqual([]);
    expect(readOAuthResourceOptions(auth)).toEqual({
      issuer: "https://auth.example",
      scopes: ["agent:invoke"],
    });
  });

  it("rejects invalid resource metadata at authoring time", () => {
    expect(() =>
      oauthResource(() => principal, {
        authorizationServers: [],
      }),
    ).toThrow("at least one HTTPS authorization server URL");
    expect(() =>
      oauthResource(() => principal, {
        issuer: "https://auth.example",
        metadataPath: "oauth-protected-resource",
      }),
    ).toThrow("metadataPath must be an absolute path");
  });

  it("requires secure OAuth identifiers and a same-origin metadata path", () => {
    for (const issuer of [
      "ftp://auth.example",
      "http://auth.example",
      "http://127.attacker.example",
      "https://user:secret@auth.example",
      "https://auth.example?tenant=one",
      "https://auth.example#fragment",
    ]) {
      expect(() => oauthResource(() => principal, { issuer })).toThrow(
        "HTTPS authorization server URL",
      );
    }

    expect(() =>
      oauthResource(() => principal, {
        issuer: "https://auth.example",
        resource: "http://agent.example/mcp",
      }),
    ).toThrow("resource must be an HTTPS URL");
    expect(() =>
      oauthResource(() => principal, {
        issuer: "https://auth.example",
        metadataPath: "//attacker.example/metadata",
      }),
    ).toThrow("metadataPath must be an absolute path");

    expect(() =>
      oauthResource(() => principal, {
        issuer: "http://localhost:3000",
        resource: "http://127.0.0.1:2117/mcp",
      }),
    ).not.toThrow();
  });
});
