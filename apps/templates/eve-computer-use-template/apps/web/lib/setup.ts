/**
 * How the app lets people in, from its runtime environment. The chat template upgrades the same
 * pattern to per-user Sign in with Vercel; see the README.
 *
 * - `local-dev`: `pnpm dev:all` on your machine, open to you.
 * - `password`: `EVE_COMPUTER_USE_PASSWORD` is set; one shared password.
 * - `unconfigured`: a deployment without a password, which lets no one in.
 */
export type AuthMode = "local-dev" | "password" | "unconfigured";

export function getAuthMode(): AuthMode {
  if (process.env.EVE_COMPUTER_USE_PASSWORD?.trim()) return "password";
  // `vercel dev` sets VERCEL=1 too, so only the Node environment marks local development.
  if (process.env.NODE_ENV === "development") return "local-dev";
  return "unconfigured";
}
