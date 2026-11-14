import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  findBannedWords,
  MAX_DRAFT_LENGTH,
  parseBannedWords,
  STYLE_RULES,
} from "#lib/content/config.js";
import { judgeRules } from "#lib/decisions/config.js";
import {
  AI_PHRASES_TO_AVOID,
  PLAIN_ENGLISH_ALTERNATIVES,
} from "#lib/writing-quality/config.js";

/**
 * The style-lint tool.
 *
 * @remarks
 * eve resolves an agent's tools from its own `tools/` directory and subagents inherit nothing, so
 * the three agents that lint a draft call this factory from a one-line file in their own `tools/`.
 *
 * Input bounds and the matching logic live in `config.ts`; this module is the tool interface over
 * them.
 *
 * @packageDocumentation
 */

/**
 * Tool that checks a draft against the active surface's banned-words list and two judgment rules.
 *
 * @remarks
 * The check runs in two layers. The banned-words pass is deterministic and always reported. The
 * {@link STYLE_RULES} then go to the decision model, judged against the `writing-quality` skill's
 * own reference text, and come back as a verdict per rule. When the decision model is unavailable
 * the banned-words result still returns, with `judged` set to false.
 *
 * Each agent passes the `references/banned-words.json` list of every `<surface>-style` skill it
 * authors, imported from the skill directory, so each style skill stays the source of truth for its
 * own surface. The keys become the tool's `surface` enum, which means the list a call checks
 * against comes from a fixed map and can never be influenced by the caller. A list that fails
 * validation is treated as "no banned words" rather than failing the check.
 *
 * The lists are validated once, when the tool is built, rather than on every call.
 *
 * @param bannedWordsBySurface - Each surface's parsed `banned-words.json`, keyed by surface.
 * @returns The configured tool.
 * @throws When no surface is passed, since the tool would have nothing to check against.
 */
export const lintAgainstStyleTool = <const Surface extends string>(
  bannedWordsBySurface: Readonly<Record<Surface, unknown>>
) => {
  const surfaces = Object.keys(bannedWordsBySurface) as Surface[];
  const [first, ...rest] = surfaces;
  if (first === undefined) {
    throw new Error("lintAgainstStyleTool needs at least one surface.");
  }
  const bannedBySurface = new Map(
    surfaces.map((surface) => [
      surface,
      parseBannedWords(bannedWordsBySurface[surface]),
    ])
  );

  return defineTool({
    description:
      "Check a draft against the target surface's banned-words list and against two judgment " +
      "rules: whether it avoids AI-sounding phrasing and whether it is in plain English. Run it " +
      "on each draft before proposing that draft, once per surface when a piece targets several, " +
      "and again after a rewrite. Fix every violation and every failed check. An unsure check, " +
      "or a result with `judged` false, means that rule is yours to judge by reading the draft. " +
      "A clean result is a floor rather than a verdict: it means nothing was caught, not that " +
      "the draft is good, so the surface's style skill still governs.",
    /**
     * Scan `text` for banned words, then ask the decision model the judgment rules.
     *
     * @param input - Validated tool input.
     * @param input.surface - Content surface whose style skill supplies the banned-words list.
     * @param input.text - Draft text to check.
     * @param ctx - Tool context; supplies the call's `abortSignal`.
     * @returns `ok`, the banned-word `violations`, the per-rule `checks`, and whether the rules
     * were `judged` at all.
     */
    async execute({ surface, text }, ctx) {
      const hits = findBannedWords(text, bannedBySurface.get(surface) ?? []);
      const checks = await judgeRules(
        STYLE_RULES,
        {
          aiPhrasesToAvoid: AI_PHRASES_TO_AVOID,
          draft: text,
          plainEnglishAlternatives: PLAIN_ENGLISH_ALTERNATIVES,
        },
        ctx.abortSignal
      );
      return {
        checks: checks ?? [],
        judged: checks !== null,
        ok:
          hits.length === 0 &&
          !checks?.some((check) => check.verdict === "fail"),
        violations: hits.map(
          (word) => `Avoid "${word}" per the ${surface} style guide.`
        ),
      };
    },
    inputSchema: z.object({
      surface: z
        .enum([first, ...rest])
        .describe(
          "The surface this draft is written for. Selects which style skill's banned-words list " +
            "to check against."
        ),
      text: z
        .string()
        .min(1)
        .max(MAX_DRAFT_LENGTH)
        .describe(
          "The full draft text to scan, including every post of a thread."
        ),
    }),
    outputSchema: z.object({
      checks: z
        .array(
          z.object({
            probability: z
              .number()
              .describe(
                "The decision model's estimate (0-1) that the draft follows the rule."
              ),
            rule: z.string().describe("The judgment rule that was checked."),
            verdict: z
              .enum(["pass", "fail", "unsure"])
              .describe(
                "'pass' = the draft follows the rule; 'fail' = it breaks it; 'unsure' = too " +
                  "close to call."
              ),
          })
        )
        .describe("One entry per judgment rule. Empty when judged is false."),
      judged: z
        .boolean()
        .describe(
          "False when the decision model was unavailable, so only the banned-words pass ran."
        ),
      ok: z
        .boolean()
        .describe(
          "True when the draft contains no banned words and no judgment rule failed."
        ),
      violations: z
        .array(z.string())
        .describe(
          "One message per banned word found, naming the word and the surface."
        ),
    }),
  });
};
