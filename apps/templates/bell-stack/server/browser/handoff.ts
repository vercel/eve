import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import Browserbase from "@browserbasehq/sdk";

import { toEmbeddedBrowserbaseLiveViewUrl } from "../../lib/browser/live-view";

const HANDOFF_VERSION = "v1";
const DEFAULT_TTL_MS = 10 * 60 * 1_000;
const MAX_TTL_MS = 15 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 60 * 1_000;
const ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

interface BrowserHandoffClaim {
  version: 1;
  purpose: "browser_live_view";
  eveSessionId: string;
  browserSessionId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface BrowserHandoffTarget {
  eveSessionId: string;
  browserSessionId: string;
}

export interface IssueBrowserHandoffOptions {
  publicUrl?: string;
  secret?: string;
  now?: number;
  ttlMs?: number;
}

export interface ResolveBrowserHandoffOptions {
  apiKey?: string;
  secret?: string;
  now?: number;
  getDebuggerUrl?: (browserSessionId: string) => Promise<string | undefined>;
}

export class BrowserHandoffError extends Error {
  constructor(
    readonly code: "configuration" | "expired" | "invalid" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

export function issueBrowserHandoffUrl(
  target: BrowserHandoffTarget,
  options: IssueBrowserHandoffOptions = {},
): string {
  const publicUrl = parsePublicUrl(options.publicUrl ?? process.env.BELL_PUBLIC_URL);
  const token = issueBrowserHandoffToken(target, options);
  return new URL(`/handoff/${token}`, publicUrl).toString();
}

export function issueBrowserHandoffToken(
  target: BrowserHandoffTarget,
  options: Omit<IssueBrowserHandoffOptions, "publicUrl"> = {},
): string {
  validateId(target.eveSessionId);
  validateId(target.browserSessionId);
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(now) || now < 0) configurationError();
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
    throw new BrowserHandoffError(
      "configuration",
      "The handoff lifetime must be between 1 millisecond and 15 minutes.",
    );
  }

  const claim: BrowserHandoffClaim = {
    version: 1,
    purpose: "browser_live_view",
    eveSessionId: target.eveSessionId,
    browserSessionId: target.browserSessionId,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", handoffKey(options.secret), initializationVector);
  cipher.setAAD(Buffer.from(HANDOFF_VERSION));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(claim), "utf8"), cipher.final()]);
  return [
    HANDOFF_VERSION,
    initializationVector.toString("base64url"),
    encrypted.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

export function verifyBrowserHandoffToken(
  token: string,
  options: Pick<ResolveBrowserHandoffOptions, "secret" | "now"> = {},
): BrowserHandoffTarget & { expiresAt: number } {
  const claim = openBrowserHandoffToken(token, options);
  return {
    eveSessionId: claim.eveSessionId,
    browserSessionId: claim.browserSessionId,
    expiresAt: claim.expiresAt,
  };
}

export async function resolveBrowserHandoffLiveViewUrl(
  token: string,
  options: ResolveBrowserHandoffOptions = {},
): Promise<string> {
  const claim = openBrowserHandoffToken(token, options);
  const getDebuggerUrl =
    options.getDebuggerUrl ??
    (async (browserSessionId: string) => {
      const apiKey = options.apiKey ?? process.env.BROWSERBASE_API_KEY;
      if (!apiKey) configurationError();
      const browserbase = new Browserbase({ apiKey });
      const session = await browserbase.sessions.retrieve(browserSessionId);
      if (session.userMetadata?.networkLogging !== "false" || session.userMetadata?.sessionRecording !== "false")
        throw new BrowserHandoffError("unavailable", "The browser handoff is not available.");
      const debug = await browserbase.sessions.debug(browserSessionId);
      return debug.debuggerFullscreenUrl;
    });

  let debuggerUrl: string | undefined;
  try {
    debuggerUrl = await getDebuggerUrl(claim.browserSessionId);
  } catch (error) {
    if (error instanceof BrowserHandoffError) throw error;
    throw new BrowserHandoffError("unavailable", "The browser handoff is not available.");
  }
  const liveViewUrl = toEmbeddedBrowserbaseLiveViewUrl(debuggerUrl);
  if (!liveViewUrl) {
    throw new BrowserHandoffError("unavailable", "The browser handoff is not available.");
  }
  return liveViewUrl;
}

function openBrowserHandoffToken(
  token: string,
  options: Pick<ResolveBrowserHandoffOptions, "secret" | "now">,
): BrowserHandoffClaim {
  try {
    const [version, encodedIv, encodedBody, encodedTag, extra] = token.split(".");
    if (version !== HANDOFF_VERSION || !encodedIv || !encodedBody || !encodedTag || extra) {
      invalidToken();
    }
    const initializationVector = Buffer.from(encodedIv, "base64url");
    const authTag = Buffer.from(encodedTag, "base64url");
    if (initializationVector.byteLength !== 12 || authTag.byteLength !== 16) invalidToken();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      handoffKey(options.secret),
      initializationVector,
    );
    decipher.setAAD(Buffer.from(HANDOFF_VERSION));
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encodedBody, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const claim = JSON.parse(decrypted) as unknown;
    if (!isBrowserHandoffClaim(claim)) invalidToken();

    const now = options.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) configurationError();
    if (claim.issuedAt > now + MAX_CLOCK_SKEW_MS) invalidToken();
    if (claim.expiresAt <= claim.issuedAt || claim.expiresAt - claim.issuedAt > MAX_TTL_MS) {
      invalidToken();
    }
    if (claim.expiresAt <= now) {
      throw new BrowserHandoffError("expired", "This browser handoff link expired.");
    }
    return claim;
  } catch (error) {
    if (error instanceof BrowserHandoffError) throw error;
    invalidToken();
  }
}

function isBrowserHandoffClaim(value: unknown): value is BrowserHandoffClaim {
  if (!value || typeof value !== "object") return false;
  const claim = value as Partial<BrowserHandoffClaim>;
  return (
    claim.version === 1 &&
    claim.purpose === "browser_live_view" &&
    typeof claim.eveSessionId === "string" &&
    ID_PATTERN.test(claim.eveSessionId) &&
    typeof claim.browserSessionId === "string" &&
    ID_PATTERN.test(claim.browserSessionId) &&
    typeof claim.issuedAt === "number" &&
    Number.isSafeInteger(claim.issuedAt) &&
    typeof claim.expiresAt === "number" &&
    Number.isSafeInteger(claim.expiresAt)
  );
}

function parsePublicUrl(value?: string): URL {
  if (!value) configurationError();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    configurationError();
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    configurationError();
  }
  url.pathname = "/";
  return url;
}

function handoffKey(value?: string): Buffer {
  const secret = value ?? process.env.BELL_HANDOFF_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) configurationError();
  return createHash("sha256").update(secret, "utf8").digest();
}

function validateId(value: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new BrowserHandoffError("configuration", "A valid handoff session is required.");
  }
}

function invalidToken(): never {
  throw new BrowserHandoffError("invalid", "This browser handoff link is invalid.");
}

function configurationError(): never {
  throw new BrowserHandoffError("configuration", "Browser handoff is not configured.");
}
