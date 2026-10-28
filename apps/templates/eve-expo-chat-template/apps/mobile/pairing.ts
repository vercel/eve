export type Pair = { relay: string; token: string; bypassToken?: string };
export type PairedDevice = { agentId: string; name: string; deviceToken: string };
/** Redeem a ticket directly against the agent deployment. */
export async function redeemPair(
  candidate: Pair,
  request: (pair: Pair) => Promise<PairedDevice>,
): Promise<PairedDevice & { relay: string; bypassToken?: string }> {
  const result = await request(candidate);
  if (
    !("deviceToken" in result) ||
    typeof result.agentId !== "string" ||
    typeof result.name !== "string" ||
    typeof result.deviceToken !== "string" ||
    result.deviceToken.length < 32
  )
    throw Error("Invalid pairing response.");
  return { ...result, relay: candidate.relay, bypassToken: candidate.bypassToken };
}
/** Ignore ordinary Expo Go launches; only pairing routes should open the connect prompt. */
export function isPairLink(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return (
      (url.protocol === "eve-go:" && url.hostname === "pair" && ["", "/"].includes(url.pathname)) ||
      (["exp:", "exps:"].includes(url.protocol) &&
        Boolean(url.hostname) &&
        // Hosted bundles live under a path, e.g. exps://agent.example/start/mobile/--/pair.
        /^(?:\/[A-Za-z0-9._~-]+)*\/--\/pair$/.test(url.pathname))
    );
  } catch {
    return false;
  }
}
export function parsePair(value: string, defaults: { relay: string; bypassToken?: string }): Pair {
  const input = value.trim();
  let relayValue = defaults.relay,
    token = input,
    bypassToken = defaults.bypassToken;
  if (/^(?:eve-go|exps?):/i.test(input)) {
    if (!isPairLink(input)) throw Error("Use the complete pairing link from the web dashboard.");
    const url = new URL(input);
    relayValue = url.searchParams.get("app") || "";
    token = url.searchParams.get("token") || "";
    bypassToken = url.searchParams.get("bypass") || undefined;
  } else if (/^https?:/i.test(input)) {
    const url = new URL(input);
    relayValue = url.origin;
    token = new URLSearchParams(url.hash.slice(1)).get("pair") || "";
    if (relayValue !== defaults.relay) bypassToken = undefined;
  }
  const compact = token.toUpperCase().replace(/[\s-]/g, "");
  if (/^[A-Z0-9]{8}$/.test(compact) || /^EVE[A-HJ-NP-Z2-9]{12}$/.test(compact)) token = compact;
  else if (!/^[A-Za-z0-9_-]{32,100}$/.test(token))
    throw Error("Enter the complete code, like XXXX-XXXX.");
  if (!relayValue) throw Error("Paste the complete pairing link from your agent’s web dashboard.");
  const relay = new URL(relayValue);
  if (relay.pathname !== "/" || relay.search || relay.hash || relay.username || relay.password)
    throw Error("Invalid app address.");
  if (
    relay.protocol !== "https:" &&
    !(
      relay.protocol === "http:" &&
      /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
        relay.hostname,
      )
    )
  )
    throw Error("App must use HTTPS or a local development address.");
  if (bypassToken && !/^[A-Za-z0-9_-]{16,256}$/.test(bypassToken))
    throw Error("Invalid project access token.");
  return { relay: relay.origin, token, bypassToken };
}

type Selection = { start: number; end: number };
/** Preserve native paste/link support while treating the dash as a separator, not a character. */
export function editPairCode(
  previous: string,
  next: string,
  selection: Selection = { start: previous.length, end: previous.length },
  key?: string,
) {
  if (/^(?:https?:|eve-go:|exps?:)/i.test(next) || /^[A-Za-z0-9_-]{32,100}$/.test(next))
    return { text: next, selection: { start: next.length, end: next.length } };
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let oldEnd = previous.length,
    newEnd = next.length;
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  let compact = next.replace(/[^a-z0-9]/gi, "").toUpperCase(),
    caret = next.slice(0, newEnd).replace(/[^a-z0-9]/gi, "").length;
  if (
    previous.slice(start, oldEnd) === "-" &&
    newEnd === start &&
    selection.start === selection.end
  ) {
    const index = key === "Backspace" || (key !== "Delete" && selection.start > start) ? 3 : 4;
    compact = compact.slice(0, index) + compact.slice(index + 1);
    caret = index;
  }
  compact = compact.slice(0, 8);
  caret = Math.min(caret, compact.length);
  const text = compact.length >= 4 ? compact.slice(0, 4) + "-" + compact.slice(4) : compact;
  const position = caret + (caret >= 4 ? 1 : 0);
  return { text, selection: { start: position, end: position } };
}
