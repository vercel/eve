/**
 * How the app lets people in, from its runtime environment. The chat template upgrades the same
 * pattern to per-user Sign in with Vercel; see the README.
 *
 * - `local-dev`: `pnpm dev:all` on your machine with no password set, open to you.
 * - `password`: `EVE_COMPUTER_USE_PASSWORD` holds a generated secret (`isStrongSecret`); one
 *   shared password.
 * - `unconfigured`: a deployment without a password, or any app with one that's too short, which
 *   lets no one in.
 */
export type AuthMode = "local-dev" | "password" | "unconfigured";

/**
 * The password is the only thing between the internet and the agent, so it must look like a
 * generated secret, such as `openssl rand -base64 32`, rather than something a person would pick:
 * at least 32 characters, at least 12 of them different. No one guesses that online, so the app
 * needs no lockout that someone else could trigger.
 */
export const MIN_PASSWORD_LENGTH = 32;
const MIN_DISTINCT_CHARACTERS = 12;

export function isStrongSecret(password: string): boolean {
  return (
    password.length >= MIN_PASSWORD_LENGTH && new Set(password).size >= MIN_DISTINCT_CHARACTERS
  );
}

export function getAuthMode(): AuthMode {
  const password = process.env.EVE_COMPUTER_USE_PASSWORD?.trim() ?? "";
  // A password someone set but made weak never opens the app, in development either.
  if (password.length > 0) return isStrongSecret(password) ? "password" : "unconfigured";
  // `vercel dev` sets VERCEL=1 too, so only the Node environment marks local development.
  return process.env.NODE_ENV === "development" ? "local-dev" : "unconfigured";
}

/** Why the app is unconfigured, for its "Not configured" page. */
export function unconfiguredReason(): string {
  return process.env.EVE_COMPUTER_USE_PASSWORD?.trim()
    ? "EVE_COMPUTER_USE_PASSWORD isn't a generated secret: use at least 32 characters, at least 12 of them different."
    : "EVE_COMPUTER_USE_PASSWORD is not set.";
}
