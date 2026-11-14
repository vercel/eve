import { BANNED_WORDS } from "./banned-words.generated.js";
import type { Surface } from "./surfaces.generated.js";

/**
 * Escape regular-expression metacharacters so a banned word is matched literally.
 *
 * @remarks
 * Banned words are read from a JSON file and interpolated into a `RegExp`. Without escaping,
 * an entry containing metacharacters could raise a syntax error or, worse, a
 * catastrophic-backtracking pattern (ReDoS) evaluated against caller-supplied `text`.
 * Escaping forces a literal, linear-time match.
 *
 * @param value - Raw banned word.
 * @returns The word with all regex metacharacters backslash-escaped.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches when a string starts with an ASCII word character. */
const STARTS_WITH_WORD = /^\w/;

/** Matches when a string ends with an ASCII word character. */
const ENDS_WITH_WORD = /\w$/;

/**
 * Build a case-insensitive matcher for one banned entry.
 *
 * @remarks
 * Anchors a word boundary (`\b`) only on a side that begins or ends with a word character, so
 * ordinary words match whole-word (`just`, never `adjust`), while an entry that starts or ends
 * with punctuation or a symbol (an em dash, `etc.`) still matches literally instead of silently
 * never matching — `\b` only exists next to a word character. The entry is escaped first, so the
 * pattern stays a linear-time literal (no ReDoS) whatever it contains.
 *
 * @param word - A trimmed, non-empty banned entry.
 * @returns A `RegExp` that matches the entry within draft text.
 */
const bannedWordMatcher = (word: string): RegExp => {
  const left = STARTS_WITH_WORD.test(word) ? "\\b" : "";
  const right = ENDS_WITH_WORD.test(word) ? "\\b" : "";
  return new RegExp(`${left}${escapeRegExp(word)}${right}`, "i");
};

/**
 * Find every banned word from a surface's list that appears in a draft.
 *
 * @remarks
 * The lists live in each style skill's `references/banned-words.json` and are bundled into
 * {@link BANNED_WORDS} by `scripts/sync-shared.mjs`, because tool code can't read skill files at
 * runtime. This is the deterministic stage of the `check_style` tool: the same input always
 * yields the same hits, with no model involved.
 *
 * @param surface - Content surface whose banned-words list applies.
 * @param text - Draft text to scan; the caller bounds its length.
 * @returns The banned entries found, in list order.
 */
export const findBannedWords = (surface: Surface, text: string): string[] =>
  BANNED_WORDS[surface].filter((word) => bannedWordMatcher(word).test(text));
