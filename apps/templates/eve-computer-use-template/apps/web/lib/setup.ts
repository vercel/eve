/**
 * How the app lets people in, from its runtime environment. The chat template upgrades the same
 * pattern to per-user Sign in with Vercel; see the README.
 *
 * - `local-dev`: `pnpm dev:all` on your machine with no password set, open to you.
 * - `password`: `EVE_COMPUTER_USE_PASSWORD` is set to at least `MIN_PASSWORD_LENGTH` characters;
 *   one shared password.
 * - `unconfigured`: a deployment without a password, or any app with one that's too short, which
 *   lets no one in.
 */
export type AuthMode = "local-dev" | "password" | "unconfigured";

/** The shortest shared password the app accepts; a shorter one leaves it unconfigured. */
export const MIN_PASSWORD_LENGTH = 16;

export function getAuthMode(): AuthMode {
  const password = process.env.EVE_COMPUTER_USE_PASSWORD?.trim() ?? "";
  // A password someone set but made too short never opens the app, in development either.
  if (password.length > 0)
    return password.length >= MIN_PASSWORD_LENGTH ? "password" : "unconfigured";
  // `vercel dev` sets VERCEL=1 too, so only the Node environment marks local development.
  return process.env.NODE_ENV === "development" ? "local-dev" : "unconfigured";
}

/** Why the app is unconfigured, for its "Not configured" page. */
export function unconfiguredReason(): string {
  return process.env.EVE_COMPUTER_USE_PASSWORD?.trim()
    ? `EVE_COMPUTER_USE_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters.`
    : "EVE_COMPUTER_USE_PASSWORD is not set.";
}
