import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE, type Session, verifySessionToken } from "./session";

/** The signed-in user for a server component, route handler, or server action. */
export async function currentUser(): Promise<Session | null> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

/** Like {@link currentUser}, but sends signed-out visitors to the login page. */
export async function requireUser(): Promise<Session> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}
