"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  PASSWORD_SESSION_COOKIE_NAME,
  PASSWORD_SESSION_MAX_AGE,
  createPasswordSessionToken,
  verifyChatPassword,
} from "@/lib/password-auth";

export type LoginState = { error?: string };

const SAME_ORIGIN = "http://same-origin.invalid";

/**
 * Only same-origin paths. Browsers treat `\` like `/` and drop tabs and
 * newlines, so `/\evil.com` would otherwise become `//evil.com`.
 */
function safeNext(value: FormDataEntryValue | null): string {
  const next = typeof value === "string" ? value : "/";
  if (!next.startsWith("/") || next.startsWith("//") || /[\\\x00-\x1f\x7f]/u.test(next)) {
    return "/";
  }
  return URL.canParse(next, SAME_ORIGIN) && new URL(next, SAME_ORIGIN).origin === SAME_ORIGIN
    ? next
    : "/";
}

export async function login(_state: LoginState, formData: FormData): Promise<LoginState> {
  const password = formData.get("password");
  if (typeof password !== "string" || !verifyChatPassword(password)) {
    return { error: "Incorrect password." };
  }

  (await cookies()).set(PASSWORD_SESSION_COOKIE_NAME, createPasswordSessionToken(), {
    httpOnly: true,
    maxAge: PASSWORD_SESSION_MAX_AGE,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  redirect(safeNext(formData.get("next")));
}

export async function logout(): Promise<void> {
  (await cookies()).delete(PASSWORD_SESSION_COOKIE_NAME);
  redirect("/login");
}
