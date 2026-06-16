import { z } from "#compiled/zod/index.js";

import type { SessionCallback } from "#channel/types.js";
import { createEveCallbackRoutePath } from "#protocol/routes.js";
import { isReservedIpAddress } from "#shared/network-address.js";

export type SessionCallbackParseResult =
  | {
      readonly callback: SessionCallback;
      readonly ok: true;
    }
  | {
      readonly cause: unknown;
      readonly message: string;
      readonly ok: false;
    };

const sessionCallbackSchema = z
  .object({
    callId: z.string().min(1),
    subagentName: z.string().min(1),
    token: z.string().min(1),
    url: z.string().min(1),
  })
  .strict()
  .superRefine((callback, ctx) => {
    let url: URL;
    try {
      url = new URL(callback.url);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Callback url must be absolute.",
        path: ["url"],
      });
      return;
    }

    if (readCallbackUrlToken(url) !== callback.token) {
      ctx.addIssue({
        code: "custom",
        message: "Callback url token must match callback token.",
        path: ["url"],
      });
    }

    // SSRF guard: the framework POSTs to this URL on session completion, so a
    // caller-supplied private/link-local host (e.g. cloud metadata) must be
    // rejected. The path/token check above does not constrain the host.
    if (isReservedIpAddress(url.hostname)) {
      ctx.addIssue({
        code: "custom",
        message: "Callback url host must not be a private or reserved address.",
        path: ["url"],
      });
    }
  });

export function parseSessionCallback(value: unknown): SessionCallbackParseResult {
  const parsed = sessionCallbackSchema.safeParse(value);
  if (parsed.success) {
    return { callback: parsed.data, ok: true };
  }

  return {
    cause: parsed.error,
    message: formatSessionCallbackParseError(parsed.error),
    ok: false,
  };
}

function readCallbackUrlToken(url: URL): string | null {
  const tokenPrefix = createEveCallbackRoutePath("");
  if (!url.pathname.startsWith(tokenPrefix)) {
    return null;
  }

  const encodedToken = url.pathname.slice(tokenPrefix.length);
  if (encodedToken.length === 0 || encodedToken.includes("/")) {
    return null;
  }

  try {
    return decodeURIComponent(encodedToken);
  } catch {
    return null;
  }
}

function formatSessionCallbackParseError(error: z.ZodError): string {
  const messages = error.issues.map((issue) => {
    const path = issue.path.length === 0 ? "callback" : `callback.${issue.path.join(".")}`;
    return `${path}: ${issue.message}`;
  });
  return `Invalid callback metadata: ${messages.join("; ")}`;
}
