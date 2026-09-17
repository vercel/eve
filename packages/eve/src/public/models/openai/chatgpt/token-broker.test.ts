import { describe, expect, it, vi } from "vitest";

import { CodexBinaryNotFoundError, type CodexAppServer } from "./codex-app-server.js";
import type { ChatGptCredentialStore } from "./credential-store.js";
import { ChatGptSignInRequiredError } from "./oauth.js";
import { ChatGptSignedOutError, type ChatGptToken } from "./token.js";
import { createCodexTokenBroker } from "./token-broker.js";

const codexToken: ChatGptToken = { token: "codex-token" };
const eveToken: ChatGptToken = {
  token: "eve-token",
  expiresAt: 2_000_000_000_000,
  accountId: "acct-1",
  accountLabel: "alice@example.com",
};

function appServer(
  resolveToken: CodexAppServer["resolveToken"] = async () => codexToken,
): CodexAppServer {
  return { resolveToken: vi.fn(resolveToken), restart: vi.fn() };
}

function missingAppServer(): CodexAppServer {
  return appServer(async () => {
    throw new CodexBinaryNotFoundError();
  });
}

function credentialStore(
  resolveToken: ChatGptCredentialStore["resolveToken"] = async () => eveToken,
): ChatGptCredentialStore {
  return {
    read: vi.fn(async () => undefined),
    resolveToken: vi.fn(resolveToken),
    update: vi.fn(async () => {
      throw new Error("Unexpected credential update.");
    }),
  };
}

describe("ChatGPT token broker", () => {
  it("prefers Codex and leaves eve credentials untouched", async () => {
    const codex = appServer();
    const store = credentialStore();
    const broker = createCodexTokenBroker({ appServer: codex, store });

    await expect(broker.getToken({ reason: "request" })).resolves.toEqual(codexToken);
    expect(codex.resolveToken).toHaveBeenCalledOnce();
    expect(store.resolveToken).not.toHaveBeenCalled();
    expect(broker.credentialOwner()).toBe("codex");
  });

  it("falls back to eve only when the Codex binary is not found", async () => {
    const codex = missingAppServer();
    const store = credentialStore();
    const broker = createCodexTokenBroker({ appServer: codex, store });

    await expect(broker.getToken({ reason: "request" })).resolves.toEqual(eveToken);
    expect(store.resolveToken).toHaveBeenCalledOnce();
    expect(broker.state()).toEqual({ kind: "ready", accountLabel: "alice@example.com" });
    expect(broker.credentialOwner()).toBe("eve");
  });

  it("does not hide other app-server failures behind eve credentials", async () => {
    const codex = appServer(async () => {
      throw new Error("Codex protocol failed");
    });
    const store = credentialStore();
    const broker = createCodexTokenBroker({ appServer: codex, store });

    await expect(broker.getToken({ reason: "request" })).rejects.toThrow("Codex protocol failed");
    expect(store.resolveToken).not.toHaveBeenCalled();
    expect(broker.credentialOwner()).toBe("codex");
    expect(broker.state()).toEqual({ kind: "unavailable", reason: "Codex protocol failed" });
  });

  it("keeps eve ownership until an explicit state refresh re-probes Codex", async () => {
    let codexAvailable = false;
    const codex = appServer(async () => {
      if (!codexAvailable) throw new CodexBinaryNotFoundError();
      return codexToken;
    });
    const store = credentialStore();
    const broker = createCodexTokenBroker({ appServer: codex, store });

    await expect(broker.getToken({ reason: "request" })).resolves.toEqual(eveToken);
    await broker.getToken({ reason: "request" });
    expect(codex.resolveToken).toHaveBeenCalledOnce();

    codexAvailable = true;
    await expect(broker.refreshState()).resolves.toEqual({ kind: "ready" });
    await expect(broker.getToken({ reason: "request" })).resolves.toEqual(codexToken);
    expect(codex.resolveToken).toHaveBeenCalledTimes(2);
    expect(store.resolveToken).toHaveBeenCalledOnce();
    expect(broker.credentialOwner()).toBe("codex");
  });

  it("caches fresh resolved tokens", async () => {
    const codex = appServer();
    const broker = createCodexTokenBroker({
      appServer: codex,
      store: credentialStore(),
      now: () => 1_800_000_000_000,
    });

    await broker.getToken({ reason: "request" });
    await broker.getToken({ reason: "request" });
    expect(codex.resolveToken).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent rejected-token resolutions", async () => {
    const gate = Promise.withResolvers<ChatGptToken>();
    const codex = appServer(() => gate.promise);
    const broker = createCodexTokenBroker({ appServer: codex, store: credentialStore() });

    const first = broker.getToken({ reason: "rejected" });
    const second = broker.getToken({ reason: "rejected" });
    await vi.waitFor(() => expect(codex.resolveToken).toHaveBeenCalledOnce());
    gate.resolve(codexToken);

    await expect(Promise.all([first, second])).resolves.toEqual([codexToken, codexToken]);
    expect(codex.resolveToken).toHaveBeenCalledOnce();
  });

  it("queues a forced refresh behind an ordinary resolution", async () => {
    const gate = Promise.withResolvers<ChatGptToken>();
    const codex = appServer(
      vi
        .fn<CodexAppServer["resolveToken"]>()
        .mockReturnValueOnce(gate.promise)
        .mockResolvedValueOnce({ ...codexToken, token: "refreshed-token" }),
    );
    const broker = createCodexTokenBroker({ appServer: codex, store: credentialStore() });

    const first = broker.getToken({ reason: "request" });
    const second = broker.getToken({ reason: "rejected" });
    gate.resolve(codexToken);

    await expect(first).resolves.toEqual(codexToken);
    await expect(second).resolves.toEqual({ ...codexToken, token: "refreshed-token" });
    expect(codex.resolveToken).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ forceRefresh: true }),
    );
  });

  it("coalesces state refreshes before restarting a signed-out app-server", async () => {
    const gate = Promise.withResolvers<void>();
    let requests = 0;
    const codex = appServer(async () => {
      requests += 1;
      if (requests > 1) await gate.promise;
      throw new ChatGptSignedOutError();
    });
    const broker = createCodexTokenBroker({ appServer: codex, store: credentialStore() });
    await expect(broker.refreshState()).resolves.toEqual({ kind: "signed-out" });

    const first = broker.refreshState();
    const second = broker.refreshState();
    gate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "signed-out" },
      { kind: "signed-out" },
    ]);
    expect(codex.restart).toHaveBeenCalledOnce();
    expect(codex.resolveToken).toHaveBeenCalledTimes(2);
  });

  it("maps source reauthentication errors into broker state", async () => {
    const codex = appServer(async () => {
      throw new ChatGptSignInRequiredError();
    });
    const broker = createCodexTokenBroker({ appServer: codex, store: credentialStore() });

    await expect(broker.getToken({ reason: "rejected" })).rejects.toBeInstanceOf(
      ChatGptSignInRequiredError,
    );
    expect(broker.state()).toEqual({ kind: "reauth-required" });
  });
});
