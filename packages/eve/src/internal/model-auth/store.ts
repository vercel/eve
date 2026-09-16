import { isModelConnection, type ModelConnectionSelection } from "#shared/model-connection.js";
export { isModelConnection, type ModelConnectionSelection } from "#shared/model-connection.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { secrets } from "#compiled/just-secrets/index.js";
import { isObject } from "#shared/guards.js";

export interface VercelSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  teamId: string;
  teamName: string;
}

export async function readModelSecret(name: string): Promise<string | undefined> {
  try {
    const value = await secrets.get({ service: "eve", name });
    if (value !== null && Buffer.byteLength(value) > 2560) throw new Error();
    return value ?? undefined;
  } catch {
    throw new Error("Cannot read the OS secret store. Unlock it and retry /login.");
  }
}

export async function writeModelSecret(name: string, value: string): Promise<void> {
  try {
    if (Buffer.byteLength(value) > 2560) throw new Error();
    await secrets.set({ service: "eve", name, value });
  } catch {
    throw new Error("Cannot save to the OS secret store. Unlock it and retry /login.");
  }
}

let cachedVercelSession: VercelSession | undefined;
let cachedVercelSessionClientId: string | undefined;

export async function writeVercelSession(session: VercelSession, clientId: string): Promise<void> {
  const { accessToken: _accessToken, expiresAt: _expiresAt, ...stored } = session;
  await writeModelSecret("vercel", JSON.stringify({ clientId, ...stored }));
  cachedVercelSession = session;
  cachedVercelSessionClientId = clientId;
}

export async function readVercelSession(clientId: string): Promise<VercelSession | undefined> {
  const raw = await readModelSecret("vercel");
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Saved Vercel login is invalid. Run /login to sign in again.");
  }
  if (!isObject(value) || value.clientId !== clientId) return undefined;
  if (
    typeof value.refreshToken !== "string" ||
    typeof value.teamId !== "string" ||
    typeof value.teamName !== "string"
  ) {
    throw new Error("Saved Vercel login is invalid. Run /login to sign in again.");
  }
  return {
    accessToken:
      cachedVercelSessionClientId === clientId &&
      cachedVercelSession?.refreshToken === value.refreshToken
        ? cachedVercelSession.accessToken
        : "",
    refreshToken: value.refreshToken,
    expiresAt:
      cachedVercelSessionClientId === clientId &&
      cachedVercelSession?.refreshToken === value.refreshToken
        ? cachedVercelSession.expiresAt
        : 0,
    teamId: value.teamId,
    teamName: value.teamName,
  };
}

export async function readDefaultConnection(): Promise<ModelConnectionSelection | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(homedir(), ".eve", "connection.json"), "utf8"),
    );
    if (isObject(value) && (isModelConnection(value.selected) || value.selected === "vercel-cli"))
      return value.selected;
  } catch {
    /* A missing preference does not require authentication. */
  }
  return undefined;
}

export async function writeDefaultConnection(selected: ModelConnectionSelection): Promise<void> {
  const dir = join(homedir(), ".eve");
  await mkdir(dir, { recursive: true });
  const target = join(dir, "connection.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ selected })}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

export function modelKeySecretName(provider: "openai" | "anthropic" | "ai-gateway-key"): string {
  return provider === "ai-gateway-key" ? provider : `${provider}-key`;
}
