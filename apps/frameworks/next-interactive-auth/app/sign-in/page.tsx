type SignInPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function callbackUrl(value: string | string[] | undefined): string | null {
  const configuredOrigin = process.env.AUTH_FORM_ORIGIN;
  if (typeof value !== "string" || configuredOrigin === undefined) return null;
  try {
    const url = new URL(value);
    const allowedOrigin = new URL(configuredOrigin).origin;
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin !== allowedOrigin ||
      !url.pathname.startsWith("/eve/v1/connections/session-auth/callback/")
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = await searchParams;
  const action = callbackUrl(params.callbackUrl);

  return (
    <main className="sign-in-shell">
      <section className="sign-in-card">
        <p className="eyebrow">Example profile</p>
        <h1>Sign in to continue</h1>
        {action === null ? (
          <p className="error">
            This sign-in link is invalid or incomplete. Request a new link from the agent.
          </p>
        ) : (
          <form action={action} method="get">
            <label htmlFor="name">Name</label>
            <input autoComplete="name" id="name" name="name" maxLength={100} required />

            <label htmlFor="email">Email</label>
            <input
              autoComplete="email"
              id="email"
              name="email"
              type="email"
              maxLength={320}
              required
            />

            <button type="submit">Sign in and continue</button>
          </form>
        )}
        <p className="note">
          This test form does not verify ownership of the email address. Do not use it as production
          authentication.
        </p>
      </section>
    </main>
  );
}
