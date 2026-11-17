import { describe, expect, it } from "vitest";
import {
  createVaultSetupUrl,
  parseVaultSetupSearchParams,
  serializeLoginVaultPayload,
  vaultCreateItemSchema,
  vaultImportItemsSchema,
  vaultSetupRequestSchema,
} from "@shared/vault/schema";

describe("vault setup", () => {
  it("creates and validates a secret-free setup link", () => {
    expect(
      vaultSetupRequestSchema.safeParse({
        kind: "login",
        secret: "must-not-enter-a-url",
        target: "vault",
      }).success
    ).toBe(false);

    const url = new URL(
      createVaultSetupUrl("https://assistant.example.com", {
        identifierType: "email",
        kind: "login",
        label: "Personal login",
        origin: "https://auth.uber.com",
        target: "vault",
      })
    );

    expect(
      parseVaultSetupSearchParams(Object.fromEntries(url.searchParams))
    ).toMatchObject({
      data: {
        kind: "login",
        target: "vault",
      },
      success: true,
    });
    expect([...url.searchParams.keys()].at(-1)).toBe("label");
    expect(
      parseVaultSetupSearchParams(
        Object.fromEntries(new URL(`${url.href}Tell me when done`).searchParams)
      )
    ).toMatchObject({
      data: { label: "Personal loginTell me when done" },
      success: true,
    });
  });

  it("accepts only structured login items in a bulk import", () => {
    const login = {
      account: "",
      kind: "login" as const,
      label: "GitHub",
      secret: serializeLoginVaultPayload({
        authentication: { password: "correct horse", type: "password" },
        identifier: { type: "email", value: "person@example.com" },
        kind: "login",
        origin: "https://github.com",
        version: 2,
      }),
    };
    expect(vaultImportItemsSchema.safeParse([login]).success).toBe(true);
    expect(
      vaultImportItemsSchema.safeParse([
        { ...login, kind: "phone", secret: "+15555550100" },
      ]).success
    ).toBe(false);
  });

  it("requires a valid structured secret for new vault items", () => {
    expect(
      vaultCreateItemSchema.safeParse({
        account: "",
        kind: "login",
        label: "GitHub",
        secret: "plain password",
      }).success
    ).toBe(false);
  });
});
