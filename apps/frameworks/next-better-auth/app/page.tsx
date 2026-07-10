import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { AuthForm, SignOutButton } from "./auth-controls";
import { Chat } from "./chat";

export default async function Page() {
  const session = await auth.api.getSession({ headers: await headers() });

  return (
    <main className="page-shell">
      <header className="site-header">
        <div>
          <p className="eyebrow">Framework example</p>
          <strong>Next.js + eve + Better Auth</strong>
        </div>
        {session ? (
          <div className="signed-in-user">
            <span>
              {session.user.name} <small>{session.user.email}</small>
            </span>
            <SignOutButton />
          </div>
        ) : null}
      </header>

      {session ? (
        <Chat />
      ) : (
        <section className="auth-layout">
          <div className="intro">
            <p className="eyebrow">Cookie-to-principal flow</p>
            <h2>Sign in once. Call eve as the same user.</h2>
            <p>
              Better Auth owns the account and session. The eve channel validates that session
              cookie and maps the user onto every agent turn.
            </p>
          </div>
          <AuthForm />
        </section>
      )}
    </main>
  );
}
