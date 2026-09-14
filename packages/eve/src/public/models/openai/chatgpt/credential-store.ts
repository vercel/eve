import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { secrets } from "#compiled/just-secrets/index.js";
import { isErrnoCode, isObject } from "#shared/guards.js";
import {
  CHATGPT_LOGIN_HINT,
  ChatGptSignInRequiredError,
  requestChatGptTokens,
  type ChatGptCredentials,
  type ChatGptRefreshCredentials,
} from "./oauth.js";
import {
  ChatGptSignedOutError,
  isChatGptTokenFresh,
  type ChatGptToken,
  type ChatGptTokenResolutionInput,
} from "./token.js";

const SECRET_ID = { service: "eve", name: "chatgpt" };
const MAX_SECRET_BYTES = 2560;

export class ChatGptInvalidStoredSessionError extends Error {
  constructor() {
    super(
      "The ChatGPT session in the OS secret store is invalid. Sign in again from /model to replace it.",
    );
  }
}

export interface ChatGptCredentialStore {
  read(): Promise<ChatGptRefreshCredentials | ChatGptCredentials | undefined>;
  resolveToken(
    input: ChatGptTokenResolutionInput & { readonly fetch?: typeof fetch },
  ): Promise<ChatGptToken>;
  update(
    callback: (
      current: ChatGptRefreshCredentials | ChatGptCredentials | undefined,
    ) => Promise<ChatGptCredentials>,
    options?: { replace?: boolean },
  ): Promise<ChatGptCredentials>;
}

interface SecretStore {
  get(input: { service: string; name: string }): Promise<string | null>;
  set(input: { service: string; name: string; value: string }): Promise<void>;
}

export function createChatGptCredentialStore(
  path = join(homedir(), ".eve", "auth", "chatgpt.json"),
  secretStore: SecretStore = secrets,
): ChatGptCredentialStore {
  let cached: { sessionId: string; credentials: ChatGptCredentials } | undefined;

  async function removeLegacyFile(): Promise<void> {
    try {
      await rm(path, { force: true });
    } catch {
      throw new Error(
        "ChatGPT credentials are stored securely, but the old plaintext session could not be removed. Stop older eve processes, remove ~/.eve/auth/chatgpt.json, and retry.",
      );
    }
  }

  async function load() {
    let raw: string | null;
    try {
      raw = await secretStore.get(SECRET_ID);
    } catch {
      throw secretStoreError();
    }
    if (raw === null) {
      cached = undefined;
      return undefined;
    }
    let value: unknown;
    try {
      if (Buffer.byteLength(raw) > MAX_SECRET_BYTES) throw new Error();
      value = JSON.parse(raw);
    } catch {
      throw new ChatGptInvalidStoredSessionError();
    }
    if (
      !isObject(value) ||
      typeof value.sessionId !== "string" ||
      !value.sessionId ||
      typeof value.refreshToken !== "string" ||
      !value.refreshToken
    ) {
      throw new ChatGptInvalidStoredSessionError();
    }
    const refresh: ChatGptRefreshCredentials = {
      refreshToken: value.refreshToken,
      ...(typeof value.accountId === "string" && { accountId: value.accountId }),
      ...(typeof value.accountLabel === "string" && { accountLabel: value.accountLabel }),
    };
    // Rotation in another process does not invalidate this process's live access token.
    const credentials =
      cached?.sessionId === value.sessionId
        ? {
            ...refresh,
            accessToken: cached.credentials.accessToken,
            expiresAt: cached.credentials.expiresAt,
          }
        : refresh;
    await removeLegacyFile();
    return { sessionId: value.sessionId, credentials };
  }

  const store: ChatGptCredentialStore = {
    async read() {
      return (await load())?.credentials;
    },
    async resolveToken(input) {
      let credentials = await store.read();
      if (!credentials) {
        if (input.forceRefresh) throw new ChatGptSignInRequiredError();
        throw new ChatGptSignedOutError(
          `ChatGPT subscription is not signed in. ${CHATGPT_LOGIN_HINT}`,
        );
      }
      const rejectedToken = tokenFromCredentials(credentials)?.token;
      if (
        input.forceRefresh ||
        !isChatGptTokenFresh(tokenFromCredentials(credentials), input.now())
      ) {
        credentials = await store.update(async (current) => {
          if (!current) throw new ChatGptSignInRequiredError();
          if (
            "accessToken" in current &&
            isChatGptTokenFresh(tokenFromCredentials(current), input.now()) &&
            (!input.forceRefresh || current.accessToken !== rejectedToken)
          ) {
            return current;
          }
          return requestChatGptTokens(
            { grant_type: "refresh_token", refresh_token: current.refreshToken },
            {
              fetch: input.fetch,
              previous: current,
              now: input.now,
            },
          );
        });
      }
      const token = tokenFromCredentials(credentials);
      if (!token) throw new Error(`ChatGPT access token is unavailable. ${CHATGPT_LOGIN_HINT}`);
      return token;
    },
    async update(callback, options) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const lockPath = `${path}.lock`;
      const deadline = Date.now() + 35_000;
      for (;;) {
        try {
          await mkdir(lockPath, { mode: 0o700 });
          break;
        } catch (error) {
          if (!isErrnoCode(error, "EEXIST")) throw error;
          // Native reads/writes can each wait two minutes for OS prompts, plus OAuth refresh.
          const info = await stat(lockPath).catch((error: unknown) => {
            if (isErrnoCode(error, "ENOENT")) return undefined;
            throw error;
          });
          if (info && Date.now() - info.mtimeMs > 10 * 60_000) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
          if (Date.now() >= deadline)
            throw new Error("Another eve process is updating the ChatGPT session. Retry shortly.");
          await delay(100);
        }
      }
      try {
        const current = options?.replace ? undefined : await load();
        const next = await callback(current?.credentials);
        const sessionId = current?.sessionId ?? randomUUID();
        const value = JSON.stringify({
          sessionId,
          refreshToken: next.refreshToken,
          ...(next.accountId && { accountId: next.accountId }),
          ...(next.accountLabel && { accountLabel: next.accountLabel }),
        });
        if (Buffer.byteLength(value) > MAX_SECRET_BYTES) {
          throw new Error(
            "The ChatGPT refresh session exceeds the OS secret store's 2,560-byte limit. Use an API-key model instead.",
          );
        }
        try {
          await secretStore.set({ ...SECRET_ID, value });
        } catch {
          throw secretStoreError();
        }
        cached = { sessionId, credentials: next };
        await removeLegacyFile();
        return next;
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    },
  };
  return store;
}

let defaultStore: ChatGptCredentialStore | undefined;

export function getDefaultChatGptCredentialStore(): ChatGptCredentialStore {
  return (defaultStore ??= createChatGptCredentialStore());
}

function tokenFromCredentials(
  credentials: ChatGptCredentials | ChatGptRefreshCredentials,
): ChatGptToken | undefined {
  if (!("accessToken" in credentials)) return undefined;
  return {
    token: credentials.accessToken,
    expiresAt: credentials.expiresAt,
    ...(credentials.accountId && { accountId: credentials.accountId }),
    ...(credentials.accountLabel && { accountLabel: credentials.accountLabel }),
  };
}

function secretStoreError(): Error {
  const recovery =
    process.platform === "linux"
      ? "Install libsecret-tools and start or unlock a Secret Service keyring with a session D-Bus. Headless sessions may need an API-key model."
      : process.platform === "win32"
        ? "Allow Windows PowerShell and Credential Manager access in your user session."
        : "Unlock your login keychain and allow credential access.";
  return new Error(
    `Could not access ChatGPT credentials in the OS secret store. ${recovery} Retry from /model.`,
  );
}
