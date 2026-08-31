export const EMPTY_DELIVERY_SENTINEL = "<eve-empty-delivery/>";
const HTML_ESCAPED_EMPTY_DELIVERY_SENTINEL = "&lt;eve-empty-delivery/&gt;";

export const CONDITIONAL_DELIVERY_INSTRUCTION = `Conditional delivery\nOnly when the current task explicitly makes delivery conditional and there is nothing new to report, reply with exactly ${EMPTY_DELIVERY_SENTINEL} and no other text. This includes results already delivered or incorporated into an earlier response; do not send an acknowledgement of that redundancy. Do not use this marker for ordinary conversations, after input or approval responses, or to omit commentary from a response that still needs delivery. Never return an empty response; use the marker to intentionally deliver nothing.`;

/**
 * A whole message that is one bracketed tag, optionally followed by a second
 * one so the paired `<tag></tag>` form is covered.
 *
 * `[^<>]*` cannot cross a bracket, so every part has exactly one way to
 * match and the pattern stays linear on any input — this runs on raw model
 * output, so an ambiguous quantifier pair here would be a denial-of-service
 * vector rather than a style nit.
 */
const LONE_TAG_MESSAGE = /^<([^<>]*)>(?:\s*<([^<>]*)>)?$/;

/**
 * The inside of a tag that means the empty-delivery marker. Tolerates the
 * ways a model mangles the reserved token while clearly intending it: a
 * leading `/` (closing-tag form), inner whitespace, any casing, `_` instead
 * of `-`, a corrupted tag name that still starts with `eve` and ends in
 * `empty-delivery` (production emitted `<evedev-empty-delivery/>`), and
 * anything after the name — a self-closing `/`, or attributes.
 *
 * Spelled `(?:\s*\/)?\s*` rather than `\s*\/?\s*`: the latter's adjacent
 * whitespace quantifiers are ambiguous and backtrack quadratically. The
 * trailing `(?![a-z0-9_-])` keeps the name from bleeding into a longer word
 * without an end anchor, so the one variable-length quantifier here only
 * ever costs O(n) split attempts of O(1) work each.
 */
const SENTINEL_TAG_BODY = /^(?:\s*\/)?\s*eve[a-z0-9_-]*empty[-_]delivery(?![a-z0-9_-])/i;

/** Fence wrappers a model reaches for when it "quotes" the marker, longest first. */
const CODE_FENCES = ["```", "``", "`"] as const;
/** An info string on the opening fence, e.g. the `xml` in an ```` ```xml ```` block. */
const CODE_FENCE_INFO_STRING = /^[a-z]{1,12}\r?\n/i;
/** Sentence punctuation a model appends when it treats the marker as prose. */
const TRAILING_PUNCTUATION = /[.!\s]+$/;

function unwrapCodeFence(text: string): string {
  for (const fence of CODE_FENCES) {
    if (text.length > fence.length * 2 && text.startsWith(fence) && text.endsWith(fence)) {
      return text.slice(fence.length, -fence.length).replace(CODE_FENCE_INFO_STRING, "").trim();
    }
  }
  return text;
}

/**
 * Reduces a candidate reply to the bare token a tolerant match can read:
 * strips surrounding whitespace, a code fence, trailing sentence
 * punctuation, and HTML-escaped angle brackets. Every step is a bounded
 * string operation or an anchored linear pattern.
 */
function normalizeSentinelCandidate(text: string): string {
  const unfenced = unwrapCodeFence(text.trim().replace(TRAILING_PUNCTUATION, ""));
  return unfenced.replace(TRAILING_PUNCTUATION, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

/**
 * True when the message is nothing but a sentinel-shaped tag.
 *
 * The marker is an internal control token, so a near-miss must fail closed
 * into silence. Before this existed the matcher was two exact `includes()`
 * checks, and `<evedev-empty-delivery/>` fell through to the channel's
 * `message.completed` default — posting the literal control token into a
 * team channel.
 *
 * Anchored to the whole (normalized) message rather than matched anywhere,
 * because every caller acts on the *entire* message when this returns true:
 * `emitStreamContent` nulls the completion and `handleStepResult` drops the
 * step's assistant output. A fuzzy anywhere-match would let a legitimate
 * reply that merely discusses the marker suppress itself. The exact
 * sentinel keeps its anywhere semantics in {@link hasEmptyDeliverySentinel}
 * — a model that emits it byte-for-byte mid-message meant to stay silent.
 */
function isSentinelShapedMessage(text: string): boolean {
  const match = LONE_TAG_MESSAGE.exec(normalizeSentinelCandidate(text));
  if (match === null) {
    return false;
  }
  return match
    .slice(1)
    .filter((body) => body !== undefined)
    .every((body) => SENTINEL_TAG_BODY.test(body));
}

export function hasEmptyDeliverySentinel(text: string | null | undefined): boolean {
  if (text === null || text === undefined) {
    return false;
  }
  return (
    text.includes(EMPTY_DELIVERY_SENTINEL) ||
    text.includes(HTML_ESCAPED_EMPTY_DELIVERY_SENTINEL) ||
    isSentinelShapedMessage(text)
  );
}
