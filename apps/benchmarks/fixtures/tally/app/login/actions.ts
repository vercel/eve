"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE, signSession } from "../../lib/session";
import { users } from "../../lib/users";

const SESSION_DAYS = 14;

export async function signIn(form: FormData) {
  const user = users.find((candidate) => candidate.id === form.get("userId"));
  if (!user) redirect("/login");
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const store = await cookies();
  store.set(
    SESSION_COOKIE,
    signSession({
      userId: user.id,
      orgId: user.orgId,
      role: user.role,
      name: user.name,
      email: user.email,
      expiresAt,
    }),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: new Date(expiresAt),
    },
  );
  redirect("/invoices");
}
