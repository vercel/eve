import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OnePasswordVault } from "../../server/browser/vault/onepassword";

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), createClient: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("@1password/sdk", () => ({ createClient: mocks.createClient }));

function item() {
  return {
    id: "login-id", vault: { id: "vault-id" }, title: "Example login", category: "LOGIN",
    fields: [
      { id: "username", purpose: "USERNAME", value: "fixture-private-user" },
      { id: "password", purpose: "PASSWORD", value: "fixture-private-password" },
      { id: "otp", type: "OTP", value: "fixture-private-totp-seed" },
    ],
    urls: [
      { href: "https://EXAMPLE.com/login" },
      { href: "https://example.com/" },
      { href: "https://blocked.example/", autofillBehavior: "Never" },
      { href: "invalid" },
    ],
    notesPlain: "fixture-private-note",
  };
}

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
type Options = { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number };
const respondWith = (result: unknown) => (
  _file: string, _args: string[], _options: Options, callback: Callback,
) => callback(null, typeof result === "string" ? result : JSON.stringify(result), "");

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BELL_ONEPASSWORD_BACKEND", "cli");
  vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "");
  vi.stubEnv("OP_ACCOUNT", "account-id");
  mocks.execFile.mockImplementation((file: string, args: string[], options: Options, callback: Callback) => {
    const result = args.includes("--otp") ? "123456\n"
      : args.includes("vault") ? [{ id: "vault-id", name: "Agent vault" }]
      : args.includes("list") ? [{ id: "login-id" }] : item();
    respondWith(result)(file, args, options, callback);
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("explicit 1Password CLI compatibility", () => {
  it("lists safe metadata without initializing the SDK or returning secrets", async () => {
    const result = await new OnePasswordVault().list();
    expect(result).toEqual([{
      itemId: "login-id", vaultId: "vault-id", vaultName: "Agent vault", label: "Example login",
      allowedHosts: ["example.com"], fields: { username: true, password: true, totp: true },
    }]);
    expect(JSON.stringify(result)).not.toContain("fixture-private");
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.execFile).toHaveBeenCalledTimes(3);
  });

  it("reads credentials and hosts from one scoped item and gets only a generated OTP", async () => {
    const result = await new OnePasswordVault().login("vault-id", "login-id");
    expect(result).toEqual({
      allowedHosts: ["example.com"], username: "fixture-private-user",
      password: "fixture-private-password", totp: "123456",
    });
    expect(mocks.execFile.mock.calls.map((call) => call[1])).toEqual([
      ["--account=account-id", "item", "get", "--vault=vault-id", "--format=json", "--", "login-id"],
      ["--account=account-id", "item", "get", "--vault=vault-id", "--otp", "--", "login-id"],
    ]);
    expect(JSON.stringify(result)).not.toContain("fixture-private-totp-seed");
  });

  it("pins desktop commands to the configured account and removes ambient credentials", async () => {
    vi.stubEnv("OP_CONNECT_HOST", "https://other.example");
    vi.stubEnv("OP_CONNECT_TOKEN", "unrelated-token");
    vi.stubEnv("OP_SESSION", "unrelated-session");
    vi.stubEnv("OP_SESSION_other", "unrelated-session");
    vi.stubEnv("OP_DEBUG", "true");
    await new OnePasswordVault().list();
    for (const [file, args, options] of mocks.execFile.mock.calls) {
      expect(file).toBe("op");
      expect(args[0]).toBe("--account=account-id");
      expect(options).toMatchObject({ timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
      for (const name of ["OP_CONNECT_HOST", "OP_CONNECT_TOKEN", "OP_SESSION", "OP_SESSION_other", "OP_SERVICE_ACCOUNT_TOKEN", "OP_ACCOUNT"])
        expect(options.env).not.toHaveProperty(name);
      expect(options.env.OP_DEBUG).toBe("false");
    }
  });

  it("uses only the configured service token when both authentication modes are configured", async () => {
    vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", " fixture-service-token ");
    vi.stubEnv("OP_CONNECT_HOST", "https://other.example");
    vi.stubEnv("OP_CONNECT_TOKEN", "unrelated-token");
    await new OnePasswordVault().list();
    for (const [, args, options] of mocks.execFile.mock.calls) {
      expect(args.some((arg: string) => arg.startsWith("--account"))).toBe(false);
      expect(JSON.stringify(args)).not.toContain("fixture-service-token");
      expect(options.env.OP_SERVICE_ACCOUNT_TOKEN).toBe("fixture-service-token");
      expect(options.env).not.toHaveProperty("OP_ACCOUNT");
      expect(options.env).not.toHaveProperty("OP_CONNECT_HOST");
      expect(options.env).not.toHaveProperty("OP_CONNECT_TOKEN");
    }
  });

  it("does not use an ambient CLI account when Bell has no explicit credentials", async () => {
    vi.stubEnv("OP_ACCOUNT", "");
    vi.stubEnv("OP_SESSION", "ambient-session");
    await expect(new OnePasswordVault().list()).rejects.toThrow("explicit OP_ACCOUNT");
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it.each(["--help", "-", "item/id", "item\nother"])("rejects unsafe item ID %s before spawning", async (itemId) => {
    await expect(new OnePasswordVault().login("vault-id", itemId)).rejects.toThrow("Invalid 1Password");
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("rejects a mismatched item or vault before returning credentials", async () => {
    mocks.execFile.mockImplementation(respondWith({ ...item(), vault: { id: "other-vault" } }));
    await expect(new OnePasswordVault().login("vault-id", "login-id")).rejects.toThrow("Could not read");
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it.each(["", "fixture-private-seed", "123456\nprivate-error"])("omits unavailable or malformed OTP %j for human handoff", async (otp) => {
    mocks.execFile.mockImplementationOnce(respondWith(item())).mockImplementationOnce(respondWith(otp));
    expect(await new OnePasswordVault().login("vault-id", "login-id")).not.toHaveProperty("totp");
  });

  it("keeps provider stdout and stderr out of errors and allows retry", async () => {
    mocks.execFile.mockImplementationOnce((_file: string, _args: string[], _options: Options, callback: Callback) => {
      callback(Object.assign(new Error("fixture-private-provider-error"), {
        stdout: "fixture-private-secret", stderr: "fixture-private-details",
      }), "fixture-private-secret", "fixture-private-details");
    });
    const vault = new OnePasswordVault();
    const request = vault.list();
    await expect(request).rejects.toThrow("Could not list 1Password CLI logins");
    await expect(request).rejects.not.toHaveProperty("cause");
    expect(await vault.list()).toHaveLength(1);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("sanitizes invalid JSON errors without exposing provider output", async () => {
    mocks.execFile.mockImplementationOnce(respondWith("fixture-private-json"));
    await expect(new OnePasswordVault().login("vault-id", "login-id"))
      .rejects.toThrow(new Error("Could not read the 1Password CLI login. Check the item handle, configured account, and vault permissions."));
  });
});
