import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import vaultLogin from "../../agent/tools/vault_login";

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  nativeLogin: vi.fn(),
  secureLogin: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("../../server/browser/vault/onepassword.js", () => ({
  onePasswordVault: { login: mocks.login },
}));
vi.mock("../../server/browser/vault/native.js", () => ({
  nativeVault: { login: mocks.nativeLogin },
}));
vi.mock("../../agent/lib/task-state", () => ({
  taskState: { update: mocks.updateTask },
}));
vi.mock("../../agent/lib/browser-runtime", () => ({
  runCancelableBrowserWork: async (
    _sessionId: string,
    signal: AbortSignal,
    operation: () => Promise<unknown>,
  ) => {
    signal.throwIfAborted();
    return operation();
  },
  runBrowserOperation: async (
    _sessionId: string,
    operation: (browser: { secureLogin: typeof mocks.secureLogin }) => Promise<unknown>,
  ) => ({ result: await operation({ secureLogin: mocks.secureLogin }), workbench: {} }),
}));

const input = {
  provider: "onepassword" as const,
  itemId: "login-item",
  vaultId: "permitted-vault",
  usernameTarget: "#username",
  passwordTarget: "#password",
  submitTarget: "#submit",
  successTarget: "#account",
  totpFlow: "same_form" as const,
};
const credentials = {
  username: "fixture-private-user",
  password: "fixture-private-password",
  allowedHosts: ["shop.example"],
};
const context = (signal = new AbortController().signal) => ({
  session: { id: "vault-tool-test" }, abortSignal: signal,
});

describe("vault login tool boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.login.mockResolvedValue(credentials);
    mocks.nativeLogin.mockResolvedValue(credentials);
    mocks.secureLogin.mockResolvedValue({ status: "complete", host: "shop.example" });
  });

  it("keeps credentials inside the browser operation", async () => {
    const output = await vaultLogin.execute(input, context() as never);
    expect(mocks.login).toHaveBeenCalledExactlyOnceWith(input.vaultId, input.itemId);
    expect(mocks.secureLogin).toHaveBeenCalledWith(expect.objectContaining(credentials));
    for (const secret of [credentials.username, credentials.password]) {
      expect(JSON.stringify(output)).not.toContain(secret);
    }
  });

  it("preserves native login handles without requiring a 1Password vault ID", async () => {
    const nativeInput = { ...input, provider: "native" as const, vaultId: undefined };
    const output = await vaultLogin.execute(nativeInput, context() as never);
    expect(mocks.nativeLogin).toHaveBeenCalledExactlyOnceWith(input.itemId);
    expect(mocks.login).not.toHaveBeenCalled();
    expect(mocks.secureLogin).toHaveBeenCalledWith(expect.objectContaining(credentials));
    expect(JSON.stringify(output)).not.toContain(credentials.password);
  });

  it("defaults existing calls to 1Password and requires its vault ID", async () => {
    const schema = vaultLogin.inputSchema;
    if (!(schema instanceof z.ZodObject)) throw new Error("Expected a Zod tool schema.");
    const parsed = schema.parse({ ...input, provider: undefined });
    expect(parsed.provider).toBe("onepassword");
    await expect(vaultLogin.execute({ ...input, vaultId: undefined }, context() as never))
      .rejects.toThrow("vault ID is required");
    expect(mocks.login).not.toHaveBeenCalled();
    expect(mocks.secureLogin).not.toHaveBeenCalled();
  });

  it("does not fill credentials when cancelled during 1Password authorization", async () => {
    const controller = new AbortController();
    mocks.login.mockImplementation(async () => {
      controller.abort();
      return credentials;
    });
    await expect(vaultLogin.execute(input, context(controller.signal) as never))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.secureLogin).not.toHaveBeenCalled();
  });

  it("does not fill native credentials after cancellation", async () => {
    const controller = new AbortController();
    mocks.nativeLogin.mockImplementation(async () => {
      controller.abort();
      return credentials;
    });
    await expect(vaultLogin.execute({ ...input, provider: "native" }, context(controller.signal) as never))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.secureLogin).not.toHaveBeenCalled();
  });

  it("preserves the browser runtime's CAPTCHA wait state", async () => {
    mocks.secureLogin.mockResolvedValue({ status: "waiting_for_user", reason: "captcha" });
    await vaultLogin.execute(input, context() as never);
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });

  it("records an unavailable OTP as waiting for the user", async () => {
    mocks.secureLogin.mockResolvedValue({ status: "waiting_for_user", host: "shop.example" });
    await vaultLogin.execute(input, context() as never);
    const update = mocks.updateTask.mock.calls[0][0];
    expect(update({})).toMatchObject({ status: "waiting_for_user", waitReason: "otp" });
  });
});
