import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatGptInvalidStoredSessionError,
  createChatGptCredentialStore,
} from "./credential-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function credentialPath() {
  const root = await mkdtemp(join(tmpdir(), "eve-chatgpt-auth-"));
  roots.push(root);
  const path = join(root, "auth", "chatgpt.json");
  await mkdir(dirname(path), { mode: 0o700 });
  return path;
}

function memorySecrets(initial: string | null = null) {
  let value = initial;
  return {
    get: vi.fn(async (_input: { service: string; name: string }) => value),
    set: vi.fn(async (input: { service: string; name: string; value: string }) => {
      value = input.value;
    }),
    current: () => value,
    replace: (next: string | null) => {
      value = next;
    },
  };
}

const credentials = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 2_000_000_000_000,
  accountId: "account-1",
  accountLabel: "alice@example.test",
};
const refreshCredentials = {
  refreshToken: credentials.refreshToken,
  accountId: credentials.accountId,
  accountLabel: credentials.accountLabel,
};

describe("ChatGPT credential storage", () => {
  it("keeps long access tokens in memory and persists only the refresh session", async () => {
    const path = await credentialPath();
    const native = memorySecrets();
    const store = createChatGptCredentialStore(path, native);
    const session = { ...credentials, accessToken: `header.${"a".repeat(6000)}.signature` };
    await writeFile(path, JSON.stringify(session));

    await expect(store.read()).resolves.toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(JSON.stringify(session));
    await expect(store.update(async () => session)).resolves.toEqual(session);

    expect(native.set).toHaveBeenCalledWith({
      service: "eve",
      name: "chatgpt",
      value: expect.any(String),
    });
    expect(JSON.parse(native.current()!)).toEqual({
      sessionId: expect.any(String),
      ...refreshCredentials,
    });
    expect(native.current()).not.toContain(session.accessToken);
    expect(Buffer.byteLength(native.current()!)).toBeLessThanOrEqual(2560);
    expect(await readdir(dirname(path))).toEqual([]);
    await expect(store.read()).resolves.toEqual(session);
    await expect(createChatGptCredentialStore(path, native).read()).resolves.toEqual(
      refreshCredentials,
    );
  });

  it("preserves warm access across rotation but invalidates it after a replacement login", async () => {
    const path = await credentialPath();
    const native = memorySecrets();
    const first = createChatGptCredentialStore(path, native);
    const second = createChatGptCredentialStore(path, native);
    await first.update(async () => credentials);
    const initialId = JSON.parse(native.current()!).sessionId;

    const rotated = { ...credentials, refreshToken: "rotated", accessToken: "second-access" };
    await second.update(async () => rotated);
    expect(JSON.parse(native.current()!).sessionId).toBe(initialId);
    await expect(first.read()).resolves.toEqual({ ...credentials, refreshToken: "rotated" });

    const replacement = {
      ...credentials,
      accessToken: "replacement-access",
      refreshToken: "replacement-refresh",
    };
    const replace = vi.fn(async () => replacement);
    await second.update(replace, { replace: true });
    expect(replace).toHaveBeenCalledWith(undefined);
    expect(JSON.parse(native.current()!).sessionId).not.toBe(initialId);
    await expect(first.read()).resolves.toEqual({
      ...refreshCredentials,
      refreshToken: "replacement-refresh",
    });
    await expect(second.read()).resolves.toEqual(replacement);
  });

  it("clears warm credentials when the OS entry is deleted", async () => {
    const path = await credentialPath();
    const native = memorySecrets();
    const store = createChatGptCredentialStore(path, native);
    await store.update(async () => credentials);
    const previous = native.current();
    native.replace(null);
    await expect(store.read()).resolves.toBeUndefined();
    native.replace(previous);
    await expect(store.read()).resolves.toEqual(refreshCredentials);
  });

  it("serializes independent stores and rereads the latest refresh token inside the lock", async () => {
    const path = await credentialPath();
    const native = memorySecrets();
    const first = createChatGptCredentialStore(path, native);
    const second = createChatGptCredentialStore(path, native);
    await first.update(async () => credentials);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const observed: string[] = [];
    const firstUpdate = first.update(async (current) => {
      observed.push(current?.refreshToken ?? "missing");
      entered.resolve();
      await release.promise;
      return { ...credentials, refreshToken: "refresh-rotated" };
    });
    await entered.promise;
    const secondUpdate = second.update(async (current) => {
      observed.push(current?.refreshToken ?? "missing");
      return { ...credentials, refreshToken: `${current?.refreshToken}-again` };
    });
    release.resolve();
    await Promise.all([firstUpdate, secondUpdate]);
    expect(observed).toEqual(["refresh", "refresh-rotated"]);
    expect(JSON.parse(native.current()!).refreshToken).toBe("refresh-rotated-again");
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the prior session and releases the lock if refresh fails", async () => {
    const path = await credentialPath();
    const native = memorySecrets();
    const store = createChatGptCredentialStore(path, native);
    await store.update(async () => credentials);
    const saved = native.current();
    await expect(
      store.update(async () => {
        throw new Error("temporary failure");
      }),
    ).rejects.toThrow("temporary failure");
    expect(native.current()).toBe(saved);
    expect(native.set).toHaveBeenCalledOnce();
    await expect(store.read()).resolves.toEqual(credentials);
    await expect(store.update(async () => credentials)).resolves.toEqual(credentials);
  });

  it.each(["get", "set"] as const)(
    "sanitizes native %s failures and preserves plaintext until a successful secure save",
    async (operation) => {
      const path = await credentialPath();
      const native = memorySecrets();
      const store = createChatGptCredentialStore(path, native);
      await writeFile(path, "old-plaintext-token");
      native[operation].mockRejectedValueOnce(new Error("native-secret-output"));
      const failure = await store.update(async () => credentials).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("OS secret store");
      expect(String(failure)).not.toContain("native-secret-output");
      expect(failure).not.toHaveProperty("cause");
      expect(native.current()).toBeNull();
      expect(await readFile(path, "utf8")).toBe("old-plaintext-token");
      await expect(stat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });

      await expect(store.update(async () => credentials)).resolves.toEqual(credentials);
      await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("recovers when a native write reports failure after committing the session", async () => {
    const path = await credentialPath();
    const native = memorySecrets();
    const store = createChatGptCredentialStore(path, native);
    await writeFile(path, "old-plaintext-token");
    native.set.mockImplementationOnce(async ({ value }) => {
      native.replace(value);
      throw new Error("native-secret-output");
    });
    await expect(store.update(async () => credentials)).rejects.toThrow("OS secret store");
    expect(await readFile(path, "utf8")).toBe("old-plaintext-token");
    await expect(store.read()).resolves.toEqual(refreshCredentials);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(native.set).toHaveBeenCalledOnce();
  });

  it.each([
    "sensitive-token",
    "null",
    JSON.stringify({ sessionId: "", refreshToken: "sensitive-token" }),
    JSON.stringify({ sessionId: "session", refreshToken: "" }),
    "x".repeat(2561),
  ])("replaces an invalid OS record after explicit sign-in (%#)", async (raw) => {
    const path = await credentialPath();
    const native = memorySecrets(raw);
    const store = createChatGptCredentialStore(path, native);
    await writeFile(path, "old-plaintext-token");
    const failure = await store.read().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChatGptInvalidStoredSessionError);
    expect(String(failure)).not.toContain("sensitive-token");
    const refresh = vi.fn(async () => credentials);
    await expect(store.update(refresh)).rejects.toBeInstanceOf(ChatGptInvalidStoredSessionError);
    expect(refresh).not.toHaveBeenCalled();
    expect(native.set).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("old-plaintext-token");

    await expect(store.update(refresh, { replace: true })).resolves.toEqual(credentials);
    expect(refresh).toHaveBeenCalledWith(undefined);
    await expect(store.read()).resolves.toEqual(credentials);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries legacy cleanup after secure persistence succeeds but removal fails", async () => {
    const path = await credentialPath();
    const native = memorySecrets();
    const store = createChatGptCredentialStore(path, native);
    await mkdir(path);
    await expect(store.update(async () => credentials)).rejects.toThrow(
      "the old plaintext session could not be removed",
    );
    expect(JSON.parse(native.current()!).refreshToken).toBe(credentials.refreshToken);
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });

    await rm(path, { recursive: true });
    await writeFile(path, "old-plaintext-token");
    await expect(store.read()).resolves.toEqual(credentials);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(native.set).toHaveBeenCalledOnce();
  });

  it("rejects oversized UTF-8 refresh records before any native write", async () => {
    const path = await credentialPath();
    const native = memorySecrets();
    const store = createChatGptCredentialStore(path, native);
    await writeFile(path, "old-plaintext-token");
    await expect(
      store.update(async () => ({ ...credentials, refreshToken: "é".repeat(1300) })),
    ).rejects.toThrow("2,560-byte limit");
    expect(native.set).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("old-plaintext-token");
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not steal a pending native write's lock after the former two-minute stale threshold", async () => {
    const path = await credentialPath();
    const native = memorySecrets();
    const first = createChatGptCredentialStore(path, native);
    const second = createChatGptCredentialStore(path, native);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const follower = Promise.withResolvers<string | undefined>();
    native.set.mockImplementationOnce(async ({ value }) => {
      entered.resolve();
      await release.promise;
      native.replace(value);
    });
    const firstUpdate = first.update(async () => credentials);
    await entered.promise;
    const old = new Date(Date.now() - 121_000);
    await utimes(`${path}.lock`, old, old);
    const secondUpdate = second.update(async (current) => {
      follower.resolve(current?.refreshToken);
      return { ...credentials, refreshToken: `${current?.refreshToken}-rotated` };
    });
    try {
      await expect(
        Promise.race([follower.promise.then(() => "stolen"), delay(250, "held")]),
      ).resolves.toBe("held");
    } finally {
      release.resolve();
      await Promise.all([firstUpdate, secondUpdate]);
    }
    await expect(follower.promise).resolves.toBe(credentials.refreshToken);
    expect(JSON.parse(native.current()!).refreshToken).toBe("refresh-rotated");
  });
});
