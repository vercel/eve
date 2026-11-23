import { readEnv } from "#runtime-env/env.js";

export function checksSessionEvents(): boolean {
  const configured = readEnv("EVE_CHECK_SESSION_EVENTS");
  if (configured === "1") return true;
  if (configured === "0") return false;
  return readEnv("EVE_DEV") === "1";
}
