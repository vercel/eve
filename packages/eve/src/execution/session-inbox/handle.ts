import { createHmac, timingSafeEqual } from "node:crypto";
import { HookSchema } from "#compiled/@workflow/world/index.js";
import type { Hook } from "#internal/workflow/runtime.js";

const DOMAIN = "eve:inbox:v1:";
const MAX_HANDLE_LENGTH = 8_192;

export type InboxHook = Omit<Hook, "metadata">;

const InboxHookSchema = HookSchema.omit({ metadata: true, resumeCapabilities: true });

function parseInboxHook(value: unknown): InboxHook | undefined {
  const result = InboxHookSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function signingKey(): string | undefined {
  const key = process.env.EVE_INBOX_HANDLE_SECRET;
  return key !== undefined && key.length >= 32 ? key : undefined;
}

function signature(body: string, key: string): Buffer {
  return createHmac("sha256", key).update(DOMAIN).update(body).digest();
}

export function issueInboxHandle(hook: unknown): string | undefined {
  const key = signingKey();
  if (key === undefined) return undefined;
  const parsed = parseInboxHook(hook);
  if (parsed?.resumeContext?.encryptionPublicKey === undefined) return undefined;
  const descriptor = {
    ...parsed,
    resumeContext: { ...parsed.resumeContext, traceCarrier: undefined },
  };
  const body = Buffer.from(JSON.stringify(descriptor)).toString("base64url");
  const handle = `v1.${body}.${signature(body, key).toString("base64url")}`;
  return handle.length <= MAX_HANDLE_LENGTH ? handle : undefined;
}

export function readInboxHandle(handle: string): InboxHook | undefined {
  const key = signingKey();
  if (key === undefined || handle.length > MAX_HANDLE_LENGTH) return undefined;
  const [version, body, mac, extra] = handle.split(".");
  if (version !== "v1" || body === undefined || mac === undefined || extra !== undefined)
    return undefined;
  const expected = signature(body, key);
  const received = Buffer.from(mac, "base64url");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return undefined;
  try {
    return parseInboxHook(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

export interface RememberedInboxOwner {
  readonly hook: InboxHook;
  readonly sessionId: string;
}

const rememberedOwners = new Map<string, RememberedInboxOwner>();
const REMEMBERED_OWNERS_LIMIT = 10_000;

export function rememberInboxOwner(hook: unknown, sessionId: string): void {
  const parsed = parseInboxHook(hook);
  if (parsed?.resumeContext?.encryptionPublicKey === undefined) return;
  rememberedOwners.delete(parsed.token);
  if (rememberedOwners.size >= REMEMBERED_OWNERS_LIMIT) {
    const oldest = rememberedOwners.keys().next();
    if (oldest.done !== true) rememberedOwners.delete(oldest.value);
  }
  rememberedOwners.set(parsed.token, { hook: parsed, sessionId });
}

export function recallInboxOwner(token: string): RememberedInboxOwner | undefined {
  return rememberedOwners.get(token);
}

export function forgetInboxOwner(token: string): void {
  rememberedOwners.delete(token);
}
