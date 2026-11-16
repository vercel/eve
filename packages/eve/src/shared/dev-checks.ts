/**
 * Whether eve checks what a session writes as it writes it: each event line against the
 * protocol, and history against its invariants (every tool result follows its call, once; an
 * unread change keeps what the model read). `EVE_CHECK_SESSION_EVENTS=1` or `0` decides; otherwise
 * it's on under `eve dev`. A violation fails the write instead of storing what readers or a provider
 * would reject.
 */
export function checksSessionEvents(): boolean {
  const configured = process.env.EVE_CHECK_SESSION_EVENTS;
  if (configured === "1") return true;
  if (configured === "0") return false;
  return process.env.EVE_DEV === "1";
}
