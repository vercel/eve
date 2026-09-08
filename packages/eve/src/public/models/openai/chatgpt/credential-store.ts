import { randomUUID } from "node:crypto";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { isErrnoCode, isObject } from "#shared/guards.js";
import { renameWithTransientBusyRetry } from "#shared/rename-with-retry.js";
import type { ChatGptCredentials } from "./oauth.js";

export interface ChatGptCredentialStore {
  read(): Promise<ChatGptCredentials | undefined>;
  update(
    callback: (current: ChatGptCredentials | undefined) => Promise<ChatGptCredentials>,
  ): Promise<ChatGptCredentials>;
}

export function createChatGptCredentialStore(
  path = join(homedir(), ".eve", "auth", "chatgpt.json"),
): ChatGptCredentialStore {
  async function read(): Promise<ChatGptCredentials | undefined> {
    let value: unknown;
    try {
      const file = await open(path, "r");
      try {
        if ((await file.stat()).size > 64 * 1024) throw new Error("Credential file is too large.");
        value = JSON.parse(await file.readFile("utf8"));
      } finally {
        await file.close();
      }
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return undefined;
      throw new Error(
        "Could not read the saved ChatGPT session. Check ~/.eve/auth/chatgpt.json permissions or remove it and sign in again from /model.",
      );
    }
    if (
      !isObject(value) ||
      typeof value.accessToken !== "string" ||
      !value.accessToken ||
      typeof value.refreshToken !== "string" ||
      !value.refreshToken ||
      typeof value.expiresAt !== "number" ||
      !Number.isFinite(value.expiresAt)
    ) {
      throw new Error(
        "The saved ChatGPT session is invalid. Remove ~/.eve/auth/chatgpt.json and sign in again from /model.",
      );
    }
    return {
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      expiresAt: value.expiresAt,
      ...(typeof value.accountId === "string" && { accountId: value.accountId }),
      ...(typeof value.accountLabel === "string" && { accountLabel: value.accountLabel }),
    };
  }

  return {
    read,
    async update(callback) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const lockPath = `${path}.lock`;
      const deadline = Date.now() + 35_000;
      for (;;) {
        try {
          await mkdir(lockPath, { mode: 0o700 });
          break;
        } catch (error) {
          if (!isErrnoCode(error, "EEXIST")) throw error;
          // Token requests time out after 30 seconds; a two-minute lock survived a crash.
          const info = await stat(lockPath).catch((error: unknown) => {
            if (isErrnoCode(error, "ENOENT")) return undefined;
            throw error;
          });
          if (info && Date.now() - info.mtimeMs > 120_000) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
          if (Date.now() >= deadline)
            throw new Error("Another eve process is updating the ChatGPT session. Retry shortly.");
          await delay(100);
        }
      }
      const temporaryPath = `${path}.${randomUUID()}.tmp`;
      try {
        const next = await callback(await read());
        await writeFile(temporaryPath, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: "wx" });
        await renameWithTransientBusyRetry(temporaryPath, path);
        return next;
      } finally {
        await rm(temporaryPath, { force: true });
        await rm(lockPath, { recursive: true, force: true });
      }
    },
  };
}
