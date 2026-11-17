export function checksSessionEvents(): boolean {
  const configured = process.env.EVE_CHECK_SESSION_EVENTS;
  if (configured === "1") return true;
  if (configured === "0") return false;
  return process.env.EVE_DEV === "1";
}
