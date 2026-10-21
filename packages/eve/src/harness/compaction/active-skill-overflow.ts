/**
 * The active skills held more instructions than the compaction threshold leaves
 * room for. Compaction keeps those instructions whole, so it reports this rather
 * than truncating them.
 */
export class ActiveSkillContextOverflowError extends Error {
  readonly code = "ACTIVE_SKILL_CONTEXT_OVERFLOW";
  readonly details: {
    readonly budgetTokens: number;
    readonly estimatedTokens: number;
    readonly skills: readonly string[];
  };

  constructor(details: ActiveSkillContextOverflowError["details"]) {
    super(
      `The instructions of the active skills (${details.skills.join(", ")}) need about ${details.estimatedTokens} tokens after compaction, over the ${details.budgetTokens}-token budget. eve keeps active skill instructions whole instead of truncating them: shorten these skills, or clear the session and load fewer.`,
    );
    this.name = "ActiveSkillContextOverflowError";
    this.details = details;
  }
}
