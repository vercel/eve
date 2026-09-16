import { mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isObject, isErrnoCode } from "#shared/guards.js";
import { readVercelSession, writeVercelSession, type VercelSession } from "./store.js";

export const VERCEL_MODEL_CLIENT_ID = "cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp";
export const VERCEL_OAUTH_ISSUER = "https://vercel.com";
export const VERCEL_TEAM_HEADER = "x-vercel-ai-gateway-team";

export async function authJson(
  url: string,
  init: RequestInit = {},
  maxBytes = 256_000,
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
  const reader = response.body?.getReader();
  let raw = "";
  const decoder = new TextDecoder();
  if (reader) {
    try {
      let bytes = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > maxBytes)
          throw new Error("Authentication response was too large. Retry /login.");
        raw += decoder.decode(result.value, { stream: true });
      }
      raw += decoder.decode();
    } finally {
      await reader.cancel();
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The provider returned an invalid authentication response. Retry /login.");
  }
  if (!isObject(value))
    throw new Error("The provider returned an invalid authentication response. Retry /login.");
  if (!response.ok && typeof value.error !== "string")
    throw new Error(`Authentication failed (${response.status}). Retry /login.`);
  return value;
}

export async function vercelOAuthEndpoints(signal?: AbortSignal): Promise<{
  device: string;
  token: string;
}> {
  const metadata = await authJson(`${VERCEL_OAUTH_ISSUER}/.well-known/openid-configuration`, {
    signal,
  });
  const endpoint = (value: unknown): string => {
    const url = typeof value === "string" ? URL.parse(value) : null;
    if (
      !url ||
      ![VERCEL_OAUTH_ISSUER, "https://api.vercel.com"].includes(url.origin) ||
      url.username ||
      url.password
    )
      throw new Error("Vercel returned an unexpected OAuth endpoint. Retry /login.");
    return url.href;
  };
  return {
    device: endpoint(metadata.device_authorization_endpoint),
    token: endpoint(metadata.token_endpoint),
  };
}

export function sessionFromToken(
  value: Record<string, unknown>,
  previous?: VercelSession,
): VercelSession {
  if (
    typeof value.access_token !== "string" ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0
  )
    throw new Error("Vercel did not return a usable token. Retry /login.");
  const refreshToken =
    typeof value.refresh_token === "string" ? value.refresh_token : previous?.refreshToken;
  if (!refreshToken) throw new Error("Vercel did not return a refresh token. Retry /login.");
  return {
    accessToken: value.access_token,
    refreshToken,
    expiresAt: Date.now() + value.expires_in * 1000,
    teamId: previous?.teamId ?? "",
    teamName: previous?.teamName ?? "",
  };
}

export async function resolveVercelSession(rejectedToken?: string): Promise<VercelSession> {
  let session = await readVercelSession();
  if (!session) throw new Error("Sign in to Vercel with /login.");
  if (session.expiresAt > Date.now() + 60_000 && session.accessToken !== rejectedToken)
    return session;
  const dir = join(homedir(), ".eve", "auth");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "vercel-refresh.lock");
  const deadline = Date.now() + 35_000;
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) throw error;
      const info = await stat(lock).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > 300_000) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline)
        throw new Error("Vercel credentials are busy. Close other eve sessions and retry /login.");
      await delay(100);
    }
  }
  try {
    session = await readVercelSession();
    if (!session) throw new Error("Sign in to Vercel with /login.");
    if (session.expiresAt > Date.now() + 60_000 && session.accessToken !== rejectedToken)
      return session;
    const endpoints = await vercelOAuthEndpoints();
    const token = await authJson(endpoints.token, {
      method: "POST",
      body: new URLSearchParams({
        client_id: VERCEL_MODEL_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
      }),
    });
    session = sessionFromToken(token, session);
    await writeVercelSession(session);
    return session;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function validateVercelAccess(
  token: string,
  teamId: string,
  signal?: AbortSignal,
): Promise<void> {
  const value = await authJson(
    `https://ai-gateway.vercel.sh/coding-agent/v1/credits?teamId=${encodeURIComponent(teamId)}`,
    { headers: { authorization: `Bearer ${token}` }, signal },
  );
  if (value.error)
    throw new Error(
      "Vercel could not authorize AI Gateway for this team. Choose another team or connection in /login.",
    );
}
