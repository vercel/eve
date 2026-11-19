/**
 * How the app lets people in, from its runtime environment. The chat template upgrades the same
 * pattern to per-user Sign in with Vercel; see the README.
 *
 * - `local-dev`: `pnpm dev:all` on your machine, open to you.
 * - `password`: `EVE_COMPUTER_USE_PASSWORD` is set to at least `MIN_PASSWORD_LENGTH` characters;
 *   one shared password.
 * - `unconfigured`: a deployment without such a password, which lets no one in.
 */
export type AuthMode = "local-dev" | "password" | "unconfigured";

/** The shortest shared password the app accepts; a shorter one leaves it unconfigured. */
export const MIN_PASSWORD_LENGTH = 16;

export function getAuthMode(): AuthMode {
  if ((process.env.EVE_COMPUTER_USE_PASSWORD?.trim().length ?? 0) >= MIN_PASSWORD_LENGTH)
    return "password";
  // `vercel dev` sets VERCEL=1 too, so only the Node environment marks local development.
  if (process.env.NODE_ENV === "development") return "local-dev";
  return "unconfigured";
}

/** Why the app is unconfigured, for its "Not configured" page. */
export function unconfiguredReason(): string {
  return process.env.EVE_COMPUTER_USE_PASSWORD?.trim()
    ? `EVE_COMPUTER_USE_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters.`
    : "EVE_COMPUTER_USE_PASSWORD is not set.";
}
