import { z } from "#compiled/zod/index.js";

import type { SessionCallback } from "#channel/types.js";
import { createEveCallbackRoutePath } from "#protocol/routes.js";
import { normalizePublicEveRoutePath } from "#shared/eve-route-path.js";
import { isLocalDevelopmentServer } from "#internal/application/dev-environment.js";
import type { Entities } from "#platform/entities.js";
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

const sessionCallbackSchema = (allowLoopback: boolean) =>
  z
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

      if (isBlockedDestinationHost(url.hostname, { allowLoopback })) {
        ctx.addIssue({
          code: "custom",
          message:
            "Callback url host must not be a loopback, private, link-local, or reserved address. Loopback is allowed only on local development servers.",
          path: ["url"],
        });
      }
    });

export function parseSessionCallback(
  value: unknown,
  platform: Entities,
): SessionCallbackParseResult {
  const parsed = sessionCallbackSchema(isLocalDevelopmentServer(platform)).safeParse(value);
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
