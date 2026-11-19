import { z } from "zod";

/**
 * Input bounds and pure helpers for the shared content tooling.
 *
 * @remarks
 * A style skill is the source of truth for how a surface writes, including the
 * `references/banned-words.json` list the model reads in the sandbox. The lint tool checks against
 * those same files: each agent's `tools/lint_against_style.ts` imports its skills' lists directly,
 * so a list is edited in one place and both the model and the tool see the change on the next
 * build.
 *
 * The matching logic lives here, because it is pure and it is where the safety properties sit:
 * {@link parseBannedWords} decides what a malformed list means and {@link findBannedWords} owns the
 * regex construction. `tools.ts` is then only the interface, and these helpers stay callable by
 * whatever content tooling lands next.
 *
 * @packageDocumentation
 */

/**
 * Maximum draft length accepted by a content tool, in characters.
 *
 * @remarks
 * Bounds both the accepted input and the work done per call: every banned word is evaluated
 * against the whole draft, so an unbounded `text` would let one call scale badly. Comfortably
 * larger than any realistic draft for the supported surfaces.
 *
 * @defaultValue 100_000
 */
export const MAX_DRAFT_LENGTH = 100_000;

/**
 * Schema for a `banned-words.json` file: a flat array of strings.
 *
 * @remarks
 * Content that does not match (a non-array, or non-string elements) is rejected rather than
 * trusted, since the entries are interpolated into regular expressions.
 */
const BANNED_WORDS_SCHEMA = z.array(z.string());

/**
 * Validate and normalize the contents of a `banned-words.json` file.
 *
 * @remarks
 * Returns an empty list for anything unusable: a shape the schema rejects, or entries that are
 * blank once trimmed. Failing open is deliberate. A style skill that ships a broken list should not
 * break drafting, and the tool's own description tells the model that a clean result is a floor
 * rather than a verdict. Invalid JSON never reaches this function: the file is imported, so a
 * syntax error fails the build instead.
 *
 * @param data - The file's parsed contents.
 * @returns The trimmed, deduplicated entries, or an empty list when the contents are unusable.
 */
export const parseBannedWords = (data: unknown): string[] => {
  const result = BANNED_WORDS_SCHEMA.safeParse(data);
  if (!result.success) {
    return [];
  }
  return [...new Set(result.data.map((word) => word.trim()).filter(Boolean))];
};

/**
 * Escape regular-expression metacharacters so a banned word is matched literally.
 *
 * @remarks
 * Banned words come from a JSON file and are interpolated into a `RegExp`. Without escaping, an
 * entry containing metacharacters could raise a syntax error or, worse, a
 * catastrophic-backtracking pattern (ReDoS) evaluated against caller-supplied draft text.
 * Escaping forces a literal, linear-time match.
 *
 * @param value - Raw banned word.
 * @returns The word with all regex metacharacters backslash-escaped.
 */
const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const STARTS_WITH_WORD_CHAR = /^\w/;
const ENDS_WITH_WORD_CHAR = /\w$/;

/**
 * Build a case-insensitive whole-word matcher for one banned entry.
 *
 * @remarks
 * A `\b` boundary is only added at an edge whose character is a word character. `\b` next to
 * punctuation (an entry like `"agree?"`) can never match, so such edges are left unanchored
 * instead of silently disabling the entry.
 *
 * @param value - Raw banned entry.
 * @returns A regex matching the entry literally, bounded where word boundaries exist.
 */
const toMatcher = (value: string): RegExp => {
  const leading = STARTS_WITH_WORD_CHAR.test(value) ? "\\b" : "";
  const trailing = ENDS_WITH_WORD_CHAR.test(value) ? "\\b" : "";
  return new RegExp(`${leading}${escapeRegExp(value)}${trailing}`, "i");
};

/**
 * Find which banned words appear in a draft.
 *
 * @remarks
 * Matching is case-insensitive and whole-word where the entry's edges allow it, so `"leverage"`
 * does not fire on `"leveraged"` but a phrase entry still matches inside a sentence. Each entry is
 * reported at most once however often it occurs, because the caller reports words to fix rather
 * than counting occurrences.
 *
 * @param text - Draft text to scan.
 * @param banned - Normalized entries, as returned by {@link parseBannedWords}.
 * @returns The matching entries, in the order the list declared them.
 */
export const findBannedWords = (
  text: string,
  banned: readonly string[]
): string[] => banned.filter((word) => toMatcher(word).test(text));

/**
 * The judgment rules `lint_against_style` asks the decision model, keyed by the name reported back.
 *
 * @remarks
 * These are the two word-level judgments the shared `writing-quality` skill makes that a banned
 * words list can't: a phrase pattern is machine-made by its shape rather than by one word, and
 * plain English is a matter of degree. Both are surface-independent, so the rubric is the shared
 * skill's own reference text and no surface needs its own copy.
 *
 * Each question is phrased so that "yes" means the draft is fine.
 */
export const STYLE_RULES = {
  avoidsAiPhrasing:
    "Is the draft free of the AI-sounding phrases and patterns listed under `aiPhrasesToAvoid`?",
  usesPlainEnglish:
    "Is the draft written in plain English, preferring the simpler wording listed under " +
    "`plainEnglishAlternatives`?",
} as const;
