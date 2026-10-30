import { z } from "#compiled/zod/index.js";

import type { SessionCallback } from "#channel/types.js";
import { createEveCallbackRoutePath } from "#protocol/routes.js";
import { normalizePublicEveRoutePath } from "#shared/eve-route-path.js";
import { isLocalDevelopmentServer } from "#internal/application/dev-environment.js";
import { isBlockedDestinationHost } from "#shared/network-address.js";

type SessionCallbackParseResult =
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

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({
        code: "custom",
        message: "Callback url must use http or https.",
        path: ["url"],
      });
    }

    // SSRF guard: the framework POSTs to this URL when delegated work settles,
    // so reject blocked IP-literal and localhost hosts up front. The callback
    // transport also checks every resolved address at connect time.
    if (isBlockedDestinationHost(url.hostname, { allowLoopback: isLocalDevelopmentServer() })) {
      ctx.addIssue({
        code: "custom",
        message:
          "Callback url host must not be a loopback, private, link-local, or reserved address. Loopback is allowed only on local development servers.",
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
  // The callback route may be mounted behind a public route prefix (e.g.
  // `/eve/<name>/v1/callback/<token>`), so locate the route
  // suffix instead of anchoring at the path start. `tokenPrefix` begins
  // with `/`, so a match is always segment-aligned.
  const tokenPrefix = createEveCallbackRoutePath("");
  const pathname = normalizePublicEveRoutePath(url.pathname);
  const prefixIndex = pathname.lastIndexOf(tokenPrefix);
  if (prefixIndex === -1) {
    return null;
  }

  const encodedToken = pathname.slice(prefixIndex + tokenPrefix.length);
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
