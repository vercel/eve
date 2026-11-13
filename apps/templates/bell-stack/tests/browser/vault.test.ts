import { createCipheriv } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NativeVault } from "../../server/browser/vault/native";
import { generateTotp } from "../../server/browser/vault/totp";

const directories: string[] = [];
const masterKey = Buffer.alloc(32, 7);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bell-vault-")), path = join(directory, "vault.json");
  directories.push(directory);
  await copyFile(new URL("./fixtures/native-vault.json", import.meta.url), path);
  return { path, vault: new NativeVault(path, masterKey) };
}
async function replacePayload(path: string, payload: unknown) {
  const store = JSON.parse(await readFile(path, "utf8")), dataKey = Buffer.alloc(32, 8);
  const seal = (key: Buffer, text: Buffer) => {
    const iv = Buffer.alloc(12, 3), cipher = createCipheriv("aes-256-gcm", key, iv);
    return {
      iv: iv.toString("base64"),
      ciphertext: Buffer.concat([cipher.update(text), cipher.final()]).toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  };
  store.records[0].wrappedKey = seal(masterKey, dataKey);
  store.records[0].payload = seal(dataKey, Buffer.from(JSON.stringify(payload)));
  await writeFile(path, JSON.stringify(store));
}
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("existing local encrypted vaults", () => {
  it("reads the original v1 fixture and keeps credentials out of metadata", async () => {
    const { vault } = await fixture();
    vi.useFakeTimers();
    vi.setSystemTime(59000);
    expect(await vault.list()).toEqual([{
      provider: "native",
      itemId: "fixture-login",
      label: "Demo",
      allowedHosts: ["authenticationtest.com"],
      fields: { username: true, password: true, totp: true },
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:00.000Z",
    }]);
    expect(await vault.login("fixture-login")).toEqual({
      allowedHosts: ["authenticationtest.com"],
      username: "fixture-user",
      password: "fixture-password",
      totp: generateTotp("JBSWY3DPEHPK3PXP", 59000),
    });
    expect(JSON.stringify(await vault.list())).not.toMatch(/fixture-password|fixture-user|JBSWY/);
  });

  it.each(["base64", "hex"] as const)("uses Bell configuration with a %s master key", async (encoding) => {
    const { path } = await fixture();
    vi.stubEnv("BELL_VAULT_FILE", path);
    vi.stubEnv("BELL_VAULT_MASTER_KEY", masterKey.toString(encoding));
    await expect(new NativeVault().login("fixture-login"))
      .resolves.toMatchObject({ username: "fixture-user", password: "fixture-password" });
  });

  it("rejects a wrong key without exposing cryptographic details", async () => {
    const { path } = await fixture();
    await expect(new NativeVault(path, Buffer.alloc(32, 9)).login("fixture-login"))
      .rejects.toThrow("Could not decrypt the local vault login");
  });

  it("rejects missing or malformed master keys", async () => {
    const { path } = await fixture();
    for (const key of ["", "too-short"]) {
      vi.stubEnv("BELL_VAULT_MASTER_KEY", key);
      await expect(new NativeVault(path).login("fixture-login"))
        .rejects.toThrow("Set BELL_VAULT_MASTER_KEY");
    }
  });

  it.each([
    "{broken sensitive-payload",
    JSON.stringify({ version: 2, records: [] }),
    JSON.stringify({ version: 1, records: {} }),
    JSON.stringify({ version: 1, records: [{ id: "private-item" }] }),
  ])("rejects malformed files without returning their contents", async (source) => {
    const { path, vault } = await fixture();
    await writeFile(path, source);
    await expect(vault.list()).rejects.toThrow("Could not read the local vault");
  });

  it.each(["invalid-host", "duplicate-id", "invalid-box"])("rejects %s records", async (failure) => {
    const { path, vault } = await fixture();
    const store = JSON.parse(await readFile(path, "utf8"));
    if (failure === "invalid-host") store.records[0].allowedHosts = ["https://shop.example/path"];
    if (failure === "duplicate-id") store.records.push(store.records[0]);
    if (failure === "invalid-box") store.records[0].payload.iv = "AA==";
    await writeFile(path, JSON.stringify(store));
    await expect(vault.login("fixture-login")).rejects.toThrow("Could not read the local vault");
  });

  it("detects ciphertext tampering", async () => {
    const { path, vault } = await fixture();
    const store = JSON.parse(await readFile(path, "utf8"));
    const encrypted = Buffer.from(store.records[0].payload.ciphertext, "base64");
    encrypted[0] ^= 1;
    store.records[0].payload.ciphertext = encrypted.toString("base64");
    await writeFile(path, JSON.stringify(store));
    await expect(vault.login("fixture-login")).rejects.toThrow("Could not decrypt the local vault login");
  });

  it("rejects malformed decrypted payloads without exposing their contents", async () => {
    const { path, vault } = await fixture();
    await replacePayload(path, { password: "private-payload" });
    await expect(vault.login("fixture-login")).rejects.toThrow("Could not decrypt the local vault login");
  });

  it("treats a not-yet-created local vault as empty", async () => {
    const { path, vault } = await fixture();
    await rm(path);
    await expect(vault.list()).resolves.toEqual([]);
    await expect(vault.login("fixture-login")).rejects.toThrow("login was not found");
  });

  it("preserves password login when an invalid OTP needs human handoff", async () => {
    const { path, vault } = await fixture();
    await replacePayload(path, { username: "fixture-user", password: "fixture-password", totpSecret: "invalid!" });
    await expect(vault.login("fixture-login")).resolves.toEqual({
      allowedHosts: ["authenticationtest.com"], username: "fixture-user", password: "fixture-password",
    });
  });

  it("rejects missing login handles", async () => {
    const { vault } = await fixture();
    await expect(vault.login("missing")).rejects.toThrow("login was not found");
  });

  it("generates RFC 6238 OTPs and rejects empty keys", () => {
    expect(generateTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59000, 30, 8)).toBe("94287082");
    expect(() => generateTotp("---")).toThrow("Invalid TOTP secret");
  });
});
