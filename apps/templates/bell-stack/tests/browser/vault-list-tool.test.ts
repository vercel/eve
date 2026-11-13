import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import vaultList from "../../agent/tools/vault_list_logins";

const mocks = vi.hoisted(() => ({ nativeList: vi.fn(), onePasswordList: vi.fn() }));
vi.mock("../../server/browser/vault/native.js", () => ({ nativeVault: { list: mocks.nativeList } }));
vi.mock("../../server/browser/vault/onepassword.js", () => ({
  onePasswordVault: { list: mocks.onePasswordList },
}));

describe("configured vault discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("BELL_VAULT_MASTER_KEY", "");
    vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "");
    vi.stubEnv("OP_ACCOUNT", "");
    mocks.nativeList.mockResolvedValue([{ provider: "native", itemId: "local-item" }]);
    mocks.onePasswordList.mockResolvedValue([{ vaultId: "vault-id", itemId: "remote-item" }]);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("does not contact unconfigured optional integrations", async () => {
    expect(await vaultList.execute({}, { session: { auth: { current: { authenticator: "http-basic" } } } } as never)).toEqual({ items: [] });
    expect(mocks.nativeList).not.toHaveBeenCalled();
    expect(mocks.onePasswordList).not.toHaveBeenCalled();
  });

  it("discovers native logins without requiring 1Password", async () => {
    vi.stubEnv("BELL_VAULT_MASTER_KEY", "fixture-key");
    expect(await vaultList.execute({}, { session: { auth: { current: { authenticator: "http-basic" } } } } as never)).toEqual({
      items: [{ provider: "native", itemId: "local-item" }],
    });
    expect(mocks.onePasswordList).not.toHaveBeenCalled();
  });

  it("includes provider IDs so the selected login reaches the correct backend", async () => {
    vi.stubEnv("BELL_VAULT_MASTER_KEY", "fixture-key");
    vi.stubEnv("OP_ACCOUNT", "fixture-account");
    expect(await vaultList.execute({}, { session: { auth: { current: { authenticator: "http-basic" } } } } as never)).toEqual({ items: [
      { provider: "native", itemId: "local-item" },
      { provider: "onepassword", vaultId: "vault-id", itemId: "remote-item" },
    ] });
  });

  it("does not silently hide errors for an explicitly requested provider", async () => {
    mocks.onePasswordList.mockRejectedValue(new Error("Configure 1Password"));
    await expect(vaultList.execute({ provider: "onepassword" }, { session: { auth: { current: { authenticator: "http-basic" } } } } as never))
      .rejects.toThrow("Configure 1Password");
    expect(mocks.nativeList).not.toHaveBeenCalled();
  });
});

it("does not expose the operator's vault to an iMessage sender", async () => {
  mocks.onePasswordList.mockClear();
  await expect(vaultList.execute({ provider: "onepassword" }, { session: { auth: { current: { authenticator: "linq-message" } } } } as never)).rejects.toThrow("personal credentials");
  expect(mocks.onePasswordList).not.toHaveBeenCalled();
});
