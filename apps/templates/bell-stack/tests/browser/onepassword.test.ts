import { AutofillBehavior, ItemCategory, ItemFieldType, type Item } from "@1password/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OnePasswordVault } from "../../server/browser/vault/onepassword";

const sdk = vi.hoisted(() => ({
  createClient: vi.fn(),
  listVaults: vi.fn(),
  listItems: vi.fn(),
  getItem: vi.fn(),
}));
const cli = vi.hoisted(() => ({ listCliLogins: vi.fn(), readCliLogin: vi.fn() }));

vi.mock("../../server/browser/vault/onepassword-cli", () => cli);

vi.mock("@1password/sdk", () => ({
  createClient: sdk.createClient,
  DesktopAuth: class {
    constructor(public accountName: string) {}
  },
  ItemCategory: { Login: "Login", SecureNote: "SecureNote" },
  ItemFieldType: { Text: "Text", Concealed: "Concealed", Totp: "Totp" },
  AutofillBehavior: { ExactDomain: "ExactDomain", Never: "Never" },
}));

function loginItem(): Item {
  return {
    id: "login-id",
    vaultId: "vault-id",
    title: "Example login",
    category: ItemCategory.Login,
    fields: [
      { id: "username", title: "username", fieldType: ItemFieldType.Text, value: "fixture-user" },
      { id: "password", title: "password", fieldType: ItemFieldType.Concealed, value: "fixture-password" },
      {
        id: "otp", title: "OTP", fieldType: ItemFieldType.Totp, value: "fixture-totp-seed",
        details: { type: "Otp", content: { code: "123456" } },
      },
    ],
    websites: [
      { url: "https://EXAMPLE.com/login", label: "website", autofillBehavior: AutofillBehavior.ExactDomain },
      { url: "https://example.com/", label: "duplicate", autofillBehavior: AutofillBehavior.ExactDomain },
      { url: "https://blocked.example/", label: "no autofill", autofillBehavior: AutofillBehavior.Never },
      { url: "invalid", label: "invalid", autofillBehavior: AutofillBehavior.ExactDomain },
    ],
    sections: [], notes: "fixture-private-note", tags: [], version: 1, files: [],
    createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BELL_ONEPASSWORD_BACKEND", "");
  vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "fixture-service-token");
  vi.stubEnv("OP_ACCOUNT", "");
  sdk.createClient.mockResolvedValue({
    vaults: { list: sdk.listVaults },
    items: { list: sdk.listItems, get: sdk.getItem },
  });
  sdk.listVaults.mockResolvedValue([{ id: "vault-id", title: "Agent vault" }]);
  sdk.listItems.mockResolvedValue([{ id: "login-id", category: ItemCategory.Login }]);
  sdk.getItem.mockResolvedValue(loginItem());
});

afterEach(() => vi.unstubAllEnvs());

describe("1Password vault", () => {
  it("lists only safe Login metadata and permitted hosts", async () => {
    sdk.listItems.mockResolvedValue([
      { id: "note-id", category: ItemCategory.SecureNote },
      { id: "login-id", category: ItemCategory.Login },
    ]);
    const result = await new OnePasswordVault().list();
    expect(result).toEqual([{
      itemId: "login-id", vaultId: "vault-id", vaultName: "Agent vault", label: "Example login",
      allowedHosts: ["example.com"], fields: { username: true, password: true, totp: true },
    }]);
    expect(sdk.getItem).toHaveBeenCalledExactlyOnceWith("vault-id", "login-id");
    for (const secret of ["fixture-user", "fixture-password", "fixture-totp-seed", "fixture-private-note", "123456"])
      expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("uses one scoped read for credentials, permitted hosts, and computed OTP", async () => {
    const result = await new OnePasswordVault().login("vault-id", "login-id");
    expect(result).toEqual({
      allowedHosts: ["example.com"], username: "fixture-user", password: "fixture-password", totp: "123456",
    });
    expect(sdk.getItem).toHaveBeenCalledExactlyOnceWith("vault-id", "login-id");
    expect(sdk.listVaults).not.toHaveBeenCalled();
    expect(sdk.listItems).not.toHaveBeenCalled();
  });

  it("does not substitute a TOTP seed or provider error for an unavailable code", async () => {
    const item = loginItem();
    item.fields[2].details = { type: "Otp", content: { errorMessage: "fixture-private-provider-error" } };
    sdk.getItem.mockResolvedValue(item);
    expect(await new OnePasswordVault().login("vault-id", "login-id")).toEqual({
      allowedHosts: ["example.com"], username: "fixture-user", password: "fixture-password",
    });
  });

  it("rejects non-Login items even when they have username and password fields", async () => {
    sdk.getItem.mockResolvedValue({ ...loginItem(), category: ItemCategory.SecureNote });
    await expect(new OnePasswordVault().login("vault-id", "login-id")).rejects.toThrow("not a Login");
    expect(await new OnePasswordVault().list()).toEqual([]);
  });

  it.each(["username", "password"])("rejects a Login without a usable %s", async (field) => {
    const item = loginItem();
    item.fields.find((candidate) => candidate.id === field)!.value = "";
    sdk.getItem.mockResolvedValue(item);
    await expect(new OnePasswordVault().login("vault-id", "login-id")).rejects.toThrow("must contain a username and password");
    expect((await new OnePasswordVault().list())[0].fields[field as "username" | "password"]).toBe(false);
  });

  it("prefers the service account and reuses its client", async () => {
    vi.stubEnv("OP_ACCOUNT", "Desktop account");
    const vault = new OnePasswordVault();
    await vault.list();
    await vault.login("vault-id", "login-id");
    expect(sdk.createClient).toHaveBeenCalledExactlyOnceWith({
      auth: "fixture-service-token", integrationName: "Bell", integrationVersion: "0.1.0",
    });
  });

  it("uses desktop authorization when only an account is configured", async () => {
    vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "");
    vi.stubEnv("OP_ACCOUNT", "Desktop account");
    await new OnePasswordVault().list();
    expect(sdk.createClient).toHaveBeenCalledWith({
      auth: expect.objectContaining({ accountName: "Desktop account" }),
      integrationName: "Bell", integrationVersion: "0.1.0",
    });
  });

  it("reports missing configuration without attempting another credential source", async () => {
    vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "");
    vi.stubEnv("OP_ACCOUNT", "");
    await expect(new OnePasswordVault().list()).rejects.toThrow("Set OP_SERVICE_ACCOUNT_TOKEN");
    expect(sdk.createClient).not.toHaveBeenCalled();
  });

  it("sanitizes initialization errors and retries a failed initialization", async () => {
    sdk.createClient.mockRejectedValueOnce(new Error("fixture-private-provider-error"));
    const vault = new OnePasswordVault();
    const request = vault.list();
    await expect(request).rejects.toThrow(new Error("Could not connect to 1Password. Check the configured account and authorization."));
    await expect(request).rejects.not.toHaveProperty("cause");
    expect(await vault.list()).toHaveLength(1);
    expect(sdk.createClient).toHaveBeenCalledTimes(2);
    expect(cli.listCliLogins).not.toHaveBeenCalled();
    expect(cli.readCliLogin).not.toHaveBeenCalled();
  });

  it("rejects an invalid backend before accessing credentials", async () => {
    vi.stubEnv("BELL_ONEPASSWORD_BACKEND", "automatic");
    await expect(new OnePasswordVault().list()).rejects.toThrow("must be sdk or cli");
    expect(sdk.createClient).not.toHaveBeenCalled();
    expect(cli.listCliLogins).not.toHaveBeenCalled();
  });

  it.each(["vaults", "items", "item"])("sanitizes %s listing errors", async (operation) => {
    const method = { vaults: sdk.listVaults, items: sdk.listItems, item: sdk.getItem }[operation]!;
    method.mockRejectedValueOnce(new Error("fixture-private-provider-error"));
    const request = new OnePasswordVault().list();
    await expect(request).rejects.toThrow(new Error("Could not list 1Password logins. Check the configured account and vault permissions."));
    await expect(request).rejects.not.toHaveProperty("cause");
    expect(cli.listCliLogins).not.toHaveBeenCalled();
  });

  it("sanitizes credential read errors", async () => {
    sdk.getItem.mockRejectedValueOnce(new Error("fixture-private-provider-error"));
    const request = new OnePasswordVault().login("vault-id", "login-id");
    await expect(request).rejects.toThrow(new Error("Could not read the 1Password login. Check the item handle and vault permissions."));
    await expect(request).rejects.not.toHaveProperty("cause");
    expect(cli.readCliLogin).not.toHaveBeenCalled();
  });
});
