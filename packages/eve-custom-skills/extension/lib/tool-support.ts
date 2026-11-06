import { z } from "zod";

import { SkillLifecycleError } from "./errors.ts";
import type { SkillLifecycle } from "./lifecycle.ts";
import { requireSkillLifecycle, skillScopes } from "./runtime.ts";
import { requireScope } from "./scopes.ts";
import { SKILL_APPLICATION_MODES, type SkillAuth, type SkillScope } from "./types.ts";
import { MAX_SKILL_NAME_LENGTH, normalizeSkillName } from "./validation.ts";

export const scopeField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Which owner's skills to act on. Omit for the caller's personal skills. Use 'channel' for skills shared with everyone in the current Slack channel; unavailable in DMs.",
  );

export const nameField = z
  .string()
  .min(1)
  .max(MAX_SKILL_NAME_LENGTH)
  .describe("The bare skill name, as listed, without any load prefix.");

export const versionField = z.number().int().positive();

export const modeField = z
  .enum(SKILL_APPLICATION_MODES)
  .describe(
    "'always' injects the skill on every turn (personas, writing preferences). 'on-demand' advertises it in the prompt for loading when relevant (task procedures). 'deferred' keeps it out of the prompt until a skill search finds it (rarely needed procedures).",
  );

interface SkillToolContext {
  readonly session: { readonly auth: { readonly current: SkillAuth | null } };
}

type Failure = { success: false; error: string };

/** The id the tools address a skill by: its normalized name. */
export function skillId(name: string): string {
  return normalizeSkillName(name);
}

/**
 * Resolves the lifecycle and the requested scope, runs `operation`, and
 * turns lifecycle errors into a result the model can act on.
 */
export async function withSkillScope<T extends object>(
  ctx: SkillToolContext,
  requested: string | undefined,
  failure: string,
  operation: (skills: SkillLifecycle<SkillScope>, scope: SkillScope) => Promise<T>,
): Promise<(T & { success: true; scope: string }) | Failure> {
  try {
    const scope = requireScope(skillScopes(ctx.session.auth.current), requested);
    const result = await operation(requireSkillLifecycle(), scope);
    return { success: true, scope: scope.scope, ...result };
  } catch (error) {
    if (error instanceof SkillLifecycleError) return { success: false, error: error.message };
    console.error("[custom-skills] tool failed", error);
    return { success: false, error: failure };
  }
}

export const NEXT_TURN = "It takes effect from the next message, not in the current turn.";
