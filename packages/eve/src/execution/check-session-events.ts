/**
 * Whether eve checks the session as it runs: each line against the event contract before
 * writing it, and each step's decision against the session's tables. On under `eve dev` and with
 * `EVE_CHECK_SESSION_EVENTS=1`, off with `EVE_CHECK_SESSION_EVENTS=0`. Workflow bodies call it
 * too, so it reads nothing but the environment.
 */
export function checksSessionEvents(): boolean {
  if (typeof process === "undefined") return false;
  const configured = process.env.EVE_CHECK_SESSION_EVENTS;
  if (configured === "1") return true;
  if (configured === "0") return false;
  return process.env.EVE_DEV === "1";
}
