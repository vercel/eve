import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { getCookie, setCookie } from "@tanstack/react-start/server";
import { z } from "zod";

import {
  ACCESS_COOKIE,
  ACCESS_TOKEN_TTL_SECONDS,
  checkAccessPassword,
  isAccessConfigured,
  signAccessToken,
  verifyAccessToken,
} from "../../../agent/lib/access";

const REDIRECT_BASE = "https://placeholder.invalid";

/**
 * Whether the current browser may use the chat.
 *
 * - `open`: local dev without a password; eve's `localDev()` accepts requests.
 * - `authorized`: this browser holds a valid access cookie.
 * - `locked`: a password is set and this browser has not entered it.
 * - `unconfigured`: production without `EVE_ACCESS_PASSWORD`; nobody can chat yet.
 */
export type AccessStatus = "open" | "authorized" | "locked" | "unconfigured";

/**
 * Resolves the current browser's {@link AccessStatus} from its access cookie.
 * It runs only on the server and throws if called from the browser.
 *
 * @returns The browser's access status.
 */
export const resolveAccessStatus = createServerOnlyFn(
  async (): Promise<AccessStatus> => {
    if (!isAccessConfigured()) {
      return import.meta.env.DEV ? "open" : "unconfigured";
    }
    return (await verifyAccessToken(getCookie(ACCESS_COOKIE)))
      ? "authorized"
      : "locked";
  }
);

/**
 * Server function that resolves the current browser's {@link AccessStatus} from its cookie.
 *
 * @returns The browser's access status.
 */
export const getAccessStatus = createServerFn().handler(
  async () => await resolveAccessStatus()
);

/** Result of {@link signIn}. */
export interface SignInResult {
  /** Whether the password matched and the access cookie was set. */
  readonly ok: boolean;
}

/**
 * Server function that checks the access password and, on a match, sets the
 * access cookie. Call it with `{ data: { password } }`.
 *
 * @returns Whether sign-in succeeded.
 */
export const signIn = createServerFn({ method: "POST" })
  .validator(z.object({ password: z.string().max(1024) }))
  .handler(({ data }): SignInResult => {
    if (!checkAccessPassword(data.password)) {
      return { ok: false };
    }
    setCookie(ACCESS_COOKIE, signAccessToken(), {
      httpOnly: true,
      maxAge: ACCESS_TOKEN_TTL_SECONDS,
      path: "/",
      sameSite: "lax",
      secure: !import.meta.env.DEV,
    });
    return { ok: true };
  });

/**
 * Restricts a post-sign-in destination to same-origin paths, preventing open redirects.
 *
 * @param target - The requested destination, e.g. the `redirect` search param.
 * @returns `target` when it is a same-origin path, otherwise `"/"`.
 */
export function safeRedirect(target: string | undefined): string {
  if (target === undefined || !target.startsWith("/")) {
    return "/";
  }
  try {
    const url = new URL(target, REDIRECT_BASE);
    return url.origin === REDIRECT_BASE
      ? `${url.pathname}${url.search}${url.hash}`
      : "/";
  } catch {
    return "/";
  }
}
