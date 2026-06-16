import { describe, expect, it } from "vitest";

import { defineTool } from "#public/definitions/tool.js";
import type { TokenResult } from "#runtime/connections/types.js";

/**
 * Unit coverage for the `auth` field on {@link defineTool}: the
 * authored shape is normalized into the runtime authorization contract
 * at definition time, mirroring connection `auth` normalization.
 */
describe("defineTool auth normalization", () => {
  it("defaults a getToken-only strategy to principalType app", () => {
    const tool = defineTool({
      description: "Static-token tool.",
      inputSchema: { type: "object" },
      auth: {
        async getToken(): Promise<TokenResult> {
          return { token: "static" };
        },
      },
      execute: () => null,
    });

    expect(tool.auth).toMatchObject({ principalType: "app" });
    expect(typeof tool.auth?.getToken).toBe("function");
  });

  it("preserves an interactive strategy as principalType user", () => {
    const tool = defineTool({
      description: "Interactive tool.",
      inputSchema: { type: "object" },
      auth: {
        principalType: "user",
        async getToken(): Promise<TokenResult> {
          return { token: "live" };
        },
        async startAuthorization() {
          return { challenge: { url: "https://idp.example/auth" }, state: {} };
        },
        async completeAuthorization(): Promise<TokenResult> {
          return { token: "live" };
        },
      },
      execute: () => null,
    });

    expect(tool.auth).toMatchObject({ principalType: "user" });
    expect(typeof tool.auth?.startAuthorization).toBe("function");
    expect(typeof tool.auth?.completeAuthorization).toBe("function");
  });

  it("retains the vercelConnect marker attached by connect()", () => {
    const tool = defineTool({
      description: "Connect-backed tool.",
      inputSchema: { type: "object" },
      auth: {
        principalType: "user",
        vercelConnect: { connector: "okta" },
        async getToken(): Promise<TokenResult> {
          return { token: "live" };
        },
        async startAuthorization() {
          return { challenge: { url: "https://idp.example/auth" }, state: {} };
        },
        async completeAuthorization(): Promise<TokenResult> {
          return { token: "live" };
        },
      },
      execute: () => null,
    });

    expect(tool.auth).toMatchObject({ vercelConnect: { connector: "okta" } });
  });

  it("retains the authored displayName", () => {
    const tool = defineTool({
      description: "Branded tool.",
      inputSchema: { type: "object" },
      auth: {
        displayName: "Salesforce",
        async getToken(): Promise<TokenResult> {
          return { token: "static" };
        },
      },
      execute: () => null,
    });

    expect(tool.auth).toMatchObject({ displayName: "Salesforce", principalType: "app" });
  });

  it("rejects an empty displayName", () => {
    expect(() =>
      defineTool({
        description: "Mislabeled tool.",
        inputSchema: { type: "object" },
        auth: {
          displayName: "",
          async getToken(): Promise<TokenResult> {
            return { token: "static" };
          },
        },
        execute: () => null,
      }),
    ).toThrow(/displayName/);
  });

  it("rejects an auth object missing getToken", () => {
    expect(() =>
      defineTool({
        description: "Broken tool.",
        inputSchema: { type: "object" },
        // @ts-expect-error - getToken is required on the auth contract.
        auth: {},
        execute: () => null,
      }),
    ).toThrow(/getToken/);
  });

  it("rejects a half-declared interactive strategy", () => {
    expect(() =>
      defineTool({
        description: "Half-interactive tool.",
        inputSchema: { type: "object" },
        // @ts-expect-error - startAuthorization without completeAuthorization is invalid.
        auth: {
          principalType: "user",
          async getToken(): Promise<TokenResult> {
            return { token: "live" };
          },
          async startAuthorization() {
            return { challenge: {}, state: {} };
          },
        },
        execute: () => null,
      }),
    ).toThrow(/startAuthorization|completeAuthorization/);
  });
});
