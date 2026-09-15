import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createRequire } from "node:module";
import { isObject } from "#shared/guards.js";

async function readObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw) > 65_536) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readCliConfiguration(): Promise<
  { directory: string; config: Record<string, unknown>; teamId: string } | undefined
> {
  const home = homedir();
  const base =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? (process.env.APPDATA ?? join(home, "AppData", "Roaming"))
        : (process.env.XDG_DATA_HOME ?? join(home, ".local", "share"));
  for (const dir of [join(base, "com.vercel.cli"), join(home, ".now"), join(base, "now")]) {
    const config = await readObject(join(dir, "config.json"));
    if (config === undefined) continue;
    const teamId = typeof config.currentTeam === "string" ? config.currentTeam : undefined;
    if (!teamId) return undefined;
    return { directory: dir, config, teamId };
  }
  return undefined;
}

export async function readVercelCliTeam(): Promise<string | undefined> {
  return (await readCliConfiguration())?.teamId;
}

/** Read-only: Vercel CLI retains ownership of its credentials and token rotation. */
export async function readVercelCliConnection(): Promise<
  { token: string; teamId: string } | undefined
> {
  const configuration = await readCliConfiguration();
  if (!configuration) return undefined;
  const { directory: dir, config, teamId } = configuration;
  if (process.env.VERCEL_TOKEN) return { token: process.env.VERCEL_TOKEN, teamId };
  const storage = process.env.VERCEL_TOKEN_STORAGE ?? config.credStorage ?? "file";
  const path = join(dir, "auth.json");
  let auth: Record<string, unknown> | undefined;
  if (storage === "file") auth = await readObject(path);
  if (!auth && (storage === "keyring" || storage === "auto")) {
    const name = `cli:${createHash("sha256").update(path).digest("hex").slice(0, 16)}`;
    try {
      const raw = await readCliKeyring(name);
      const value: unknown = raw && raw.length <= 65_536 ? JSON.parse(raw) : undefined;
      if (isObject(value)) auth = value;
    } catch {
      if (storage === "keyring") return undefined;
    }
    if (!auth && storage === "auto") auth = await readObject(path);
  }
  if (typeof auth?.token !== "string" || !auth.token) return undefined;
  return { token: auth.token, teamId };
}

export async function refreshVercelCliConnection(): Promise<void> {
  try {
    await promisify(execFile)("vercel", ["whoami"], {
      timeout: 15_000,
      maxBuffer: 65_536,
      windowsHide: true,
    });
  } catch {
    throw new Error("Vercel CLI access expired. Run /login to reconnect.");
  }
}

// Use the CLI's own native adapter: just-secrets intentionally uses a different key encoding.
async function readCliKeyring(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    try {
      const executable = await realpath(
        join(directory, process.platform === "win32" ? "vercel.cmd" : "vercel"),
      );
      let require = createRequire(executable);
      if (process.platform === "win32")
        require = createRequire(require.resolve("vercel/package.json"));
      try {
        require = createRequire(require.resolve("@vercel/cli-auth/package.json"));
      } catch {
        // Older CLI installs may expose the native adapter directly.
      }
      const keyring = require("@napi-rs/keyring") as {
        Entry: new (service: string, account: string) => { getPassword(): string | null };
      };
      return new keyring.Entry("com.vercel.vercel-cli", name).getPassword() ?? undefined;
    } catch {
      // Other PATH entries may contain the installed CLI and its native adapter.
    }
  }
  return undefined;
}
