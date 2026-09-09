import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createChatGptCredentialStore } from "./credential-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function credentialPath() {
  const root = await mkdtemp(join(tmpdir(), "eve-chatgpt-auth-"));
  roots.push(root);
  return join(root, "auth", "chatgpt.json");
}
const credentials = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 2_000_000_000_000,
};

describe("ChatGPT credential storage", () => {
  it("stores credentials atomically with private permissions", async () => {
    const path = await credentialPath();
    const store = createChatGptCredentialStore(path);
    await expect(store.read()).resolves.toBeUndefined();
    await store.update(async () => credentials);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(credentials);
    if (process.platform !== "win32") expect((await stat(path)).mode % 512).toBe(0o600);
    await expect(store.read()).resolves.toEqual(credentials);
  });

  it("serializes rotation across independent stores and rereads inside the lock", async () => {
    const path = await credentialPath();
    const first = createChatGptCredentialStore(path);
    const second = createChatGptCredentialStore(path);
    await first.update(async () => credentials);
    const observed: string[] = [];
    await Promise.all(
      [first, second].map((store) =>
        store.update(async (current) => {
          observed.push(current?.refreshToken ?? "missing");
          return { ...credentials, refreshToken: `${current?.refreshToken}-rotated` };
        }),
      ),
    );
    expect(observed).toEqual(["refresh", "refresh-rotated"]);
  });

  it("keeps the prior session and releases the lock if refresh fails", async () => {
    const store = createChatGptCredentialStore(await credentialPath());
    await store.update(async () => credentials);
    await expect(
      store.update(async () => {
        throw new Error("temporary failure");
      }),
    ).rejects.toThrow("temporary failure");
    await expect(store.read()).resolves.toEqual(credentials);
    await expect(store.update(async () => credentials)).resolves.toEqual(credentials);
  });

  it("reports malformed credential files without disclosing their contents", async () => {
    const path = await credentialPath();
    const store = createChatGptCredentialStore(path);
    await store.update(async () => credentials);
    await writeFile(path, "secret-token");
    const error = await store.read().catch((value: unknown) => value);
    expect(String(error)).toContain("~/.eve/auth/chatgpt.json");
    expect(String(error)).not.toContain("secret-token");
  });
});
