import { describe, expect, it } from "vitest";

import { EMPTY_DELIVERY_SENTINEL, hasEmptyDeliverySentinel } from "#shared/empty-delivery.js";

describe("hasEmptyDeliverySentinel", () => {
  it("recognizes the exact sentinel", () => {
    expect(hasEmptyDeliverySentinel(EMPTY_DELIVERY_SENTINEL)).toBe(true);
  });

  it("recognizes an HTML-escaped sentinel", () => {
    expect(hasEmptyDeliverySentinel("&lt;eve-empty-delivery/&gt;")).toBe(true);
  });

  it("recognizes the sentinel anywhere in the response", () => {
    expect(hasEmptyDeliverySentinel(`before ${EMPTY_DELIVERY_SENTINEL} after`)).toBe(true);
  });

  // Near-misses used to be rejected, which failed open: a production model
  // typed `<evedev-empty-delivery/>` and the literal control token was
  // delivered into a team channel. A message that is nothing but a
  // sentinel-shaped tag now counts as the marker, so a mangled token becomes
  // silence instead of channel text.
  it.each([
    ["a corrupted tag name", "<evedev-empty-delivery/>"],
    ["a space before the slash", "<eve-empty-delivery />"],
    ["upper case", "<EVE-EMPTY-DELIVERY/>"],
    ["a missing self-closing slash", "<eve-empty-delivery>"],
    ["a closing-tag form", "</eve-empty-delivery>"],
    ["a paired open/close form", "<eve-empty-delivery></eve-empty-delivery>"],
    ["a corrupted paired form", "<EVEDEV-EMPTY-DELIVERY></EVEDEV-EMPTY-DELIVERY>"],
    ["a hyphenated corruption", "<eve-dev-empty-delivery/>"],
    ["underscore separators", "<eve_empty_delivery/>"],
    ["attributes", '<eve-empty-delivery reason="nothing new"/>'],
    ["surrounding whitespace", "  \n<eve-empty-delivery/>\n  "],
    ["an internal newline", "<eve-empty-delivery\n/>"],
    ["an HTML-escaped near-miss", "&lt;evedev-empty-delivery&gt;"],
    ["inner whitespace", "< eve-empty-delivery / >"],
    ["inline backticks", "`<evedev-empty-delivery/>`"],
    ["a fenced code block", "```\n<evedev-empty-delivery/>\n```"],
    ["a fenced block with an info string", "```xml\n<eve-empty-delivery/>\n```"],
    ["a trailing period", "<eve-empty-delivery/>."],
    ["a trailing exclamation mark", "<evedev-empty-delivery/>!"],
  ])("treats %s as the sentinel", (_label, text) => {
    expect(hasEmptyDeliverySentinel(text)).toBe(true);
  });

  // The tolerant pattern is anchored to the whole normalized message because
  // callers act on the entire message on a match. Anywhere-matching a fuzzy
  // pattern would let a reply that merely talks about the marker delete
  // itself.
  it.each([
    [
      "a reply that mentions a near-miss mid-sentence",
      "Reply with <eve-empty-delivery> to stay quiet.",
    ],
    ["a reply that quotes a corrupted marker", "The tag <evedev-empty-delivery/> is corrupted."],
    ["an unterminated tag", "<eve-empty-delivery is not a marker"],
    ["a differently named tag", "<eve-empty/>"],
    ["a tag that only shares the prefix", "<eve-not-a-sentinel/>"],
    ["a name that bleeds into a longer word", "<eve-empty-deliveryx/>"],
    ["an ordinary paired tag", "<div></div>"],
    ["ordinary markup around real content", "<p>Here is the report.</p>"],
    ["a marker-shaped tag wrapping content", "<eve-empty-delivery>content</eve-empty-delivery>"],
    ["a marker paired with an unrelated close", "<eve-empty-delivery></div>"],
    ["ordinary text", "Here is the report:"],
    ["the filler an unattended retry used to emit", "I now have all the data I need."],
    ["an empty string", ""],
  ])("does not treat %s as the sentinel", (_label, text) => {
    expect(hasEmptyDeliverySentinel(text)).toBe(false);
  });

  it("rejects absent sentinels", () => {
    expect(hasEmptyDeliverySentinel(null)).toBe(false);
    expect(hasEmptyDeliverySentinel(undefined)).toBe(false);
  });

  // The matcher runs on raw model output, so an ambiguous quantifier pair is
  // a denial-of-service vector. An earlier `\s*\/?\s*` spelling took ~6s on a
  // 120k-char tag; these shapes all backtrack against the current pattern and
  // must stay linear.
  it.each([
    [
      "trailing whitespace inside a tag",
      (size: number) => `<eve-empty-delivery${" ".repeat(size)}`,
    ],
    [
      "leading slash and space runs",
      (size: number) => `< ${"/ ".repeat(size / 2)}eve-empty-delivery`,
    ],
    ["a flooded tag-name class", (size: number) => `<eve${"-".repeat(size)}empty-delivery`],
    ["repeated name suffixes", (size: number) => `<eve${"empty-delivery".repeat(size / 14)}`],
    [
      "a repeated paired form",
      (size: number) =>
        `<eve${"empty-delivery".repeat(size / 28)}><eve${"empty-delivery".repeat(size / 28)}`,
    ],
  ])("rejects %s in linear time", (_label, build) => {
    const start = performance.now();
    expect(hasEmptyDeliverySentinel(build(200_000))).toBe(false);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});
