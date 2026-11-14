import { defineSkill } from "eve/skills";
import {
  AI_PHRASES_TO_AVOID,
  PLAIN_ENGLISH_ALTERNATIVES,
  WRITING_QUALITY_DESCRIPTION,
  WRITING_QUALITY_MARKDOWN,
} from "#lib/writing-quality/config.js";

/**
 * The shared `writing-quality` skill package.
 *
 * @remarks
 * eve scopes skills to the agent that declares them and there is no shared-skill mechanism, so the
 * documented alternative is a copied directory per agent. This factory is the same trade the tool
 * factories make: one definition in `lib/`, called from a one-line file under each agent's
 * `skills/`, so five agents share a single source instead of five directories that have to be kept
 * byte-identical.
 *
 * The skill name comes from the calling file's slug, so every caller must be at
 * `skills/writing-quality.ts` for the agents that reference the skill by name to resolve it. A
 * skill name has to start with an alphanumeric character; a name that fails that rule is dropped
 * from discovery without a diagnostic, so it goes missing quietly.
 *
 * `files` entries are materialized into the sandbox as real sibling files, which is what keeps the
 * `references/...` paths inside the markdown body working exactly as they did when this was an
 * authored directory.
 *
 * @returns The `writing-quality` skill definition.
 */
export const writingQualitySkill = () =>
  defineSkill({
    content: WRITING_QUALITY_MARKDOWN,
    description: WRITING_QUALITY_DESCRIPTION,
    files: {
      "references/ai-phrases-to-avoid.md": AI_PHRASES_TO_AVOID,
      "references/plain-english-alternatives.md": PLAIN_ENGLISH_ALTERNATIVES,
    },
  });
