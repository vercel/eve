import { createHmac, timingSafeEqual } from "node:crypto";
import * as workflowRuntime from "#internal/workflow/runtime.js";
import type { Hook } from "#internal/workflow/runtime.js";

const DOMAIN = "eve:inbox:v1:";
const MAX_HANDLE_LENGTH = 8_192;

type InboxHook = Omit<Hook, "metadata">;

function parseInboxHook(value: unknown): InboxHook | undefined {
  // Older SDKs accept cached hooks without the guarded write contract.
  // Require the new SDK entry point before issuing or using a handle.
  const parser: unknown = Reflect.get(workflowRuntime, "parseHookResumeHandle");
  if (typeof parser !== "function") return undefined;
  return parser(value) as InboxHook;
}

/** A shared server-only key authenticates hints carried by an untrusted client. */
function signingKey(): string | undefined {
  const key = process.env.EVE_INBOX_HANDLE_SECRET;
  return key !== undefined && key.length >= 32 ? key : undefined;
}

function signature(body: string, key: string): Buffer {
  return createHmac("sha256", key).update(DOMAIN).update(body).digest();
}

/** Opaque transport state; never includes user metadata or transient capabilities. */
export function issueInboxHandle(hook: unknown): string | undefined {
  const key = signingKey();
  if (key === undefined) return undefined;
  const parsed = parseInboxHook(hook);
  if (parsed?.resumeContext?.encryptionPublicKey === undefined) return undefined;
  // OTel carriers can include private server baggage. Signing does not hide it.
  const descriptor = {
    ...parsed,
    resumeContext: { ...parsed.resumeContext, traceCarrier: undefined },
  };
  const body = Buffer.from(JSON.stringify(descriptor)).toString("base64url");
  const handle = `v1.${body}.${signature(body, key).toString("base64url")}`;
  return handle.length <= MAX_HANDLE_LENGTH ? handle : undefined;
}

/** Verify the complete descriptor before using its routing or encryption fields. */
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
