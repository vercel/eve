import type { ConversationContext, SessionAuth, SessionAuthContext } from "eve/context";
import type { ApprovalConfiguration, ApprovalContext } from "eve/tools/approval";
import { z } from "zod";

import {
  defaultSkillApproval,
  requesterOnly,
  skillApproval,
  type PlannedChange,
} from "./approval.ts";
import { SkillChangeRefusedError, SkillLifecycleError } from "./errors.ts";
import type { SkillLifecycle } from "./lifecycle.ts";
import type { SkillHead, SkillVersionRecord } from "./repository.ts";
import { requireSkillLifecycle, skillConfig, skillScopes } from "./runtime.ts";
import { requireScope } from "./scopes.ts";
import {
  SKILL_APPLICATION_MODES,
  type SkillAction,
  type SkillApprovalTarget,
  type SkillChangeEvent,
  type SkillLiveState,
  type SkillScope,
  type StoredSkill,
} from "./types.ts";
import { INPUT_CEILINGS } from "./validation.ts";

export const scopeField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Which skill scope to act on, as `list` names it. Omit for the caller's personal skills. Use 'channel' for skills shared with everyone in the current channel or group chat.",
  );

export const nameField = z
  .string()
  .min(1)
  .max(INPUT_CEILINGS.name)
  .describe("The bare skill name, as listed, without any load prefix.");

export const versionField = z.number().int().positive();

export const modeField = z
  .enum(SKILL_APPLICATION_MODES)
  .describe(
    "'always' injects the skill on every turn (personas, writing preferences). 'on-demand' advertises it in the prompt for loading when relevant (task procedures). 'deferred' keeps it out of the prompt until a skill search finds it (rarely needed procedures).",
  );

/** What the lifecycle tools and their approvals read from eve's context. */
export interface SkillCallContext {
  readonly session: { readonly id: string; readonly auth: SessionAuth };
  readonly conversation?: ConversationContext;
}

type Failure = { success: false; error: string };

export const NEXT_TURN = "It takes effect from the next message, not in the current turn.";

export function loadName(scope: SkillScope, name: string): string {
  return `${scope.loadPrefix ?? ""}${name}`;
}

async function scopesFor(ctx: SkillCallContext) {
  return skillScopes({
    session: ctx.session,
    ...(ctx.conversation !== undefined && { conversation: ctx.conversation }),
  });
}

function toFailure(error: unknown, failure: string): Failure {
  if (error instanceof SkillLifecycleError) return { success: false, error: error.message };
  console.error("[custom-skills] tool failed", error);
  return { success: false, error: failure };
}

/** Runs a read in the requested scope and turns lifecycle errors into a result the model can act on. */
export async function withSkillScope<T extends object>(
  ctx: SkillCallContext,
  requested: string | undefined,
  failure: string,
  operation: (skills: SkillLifecycle, scope: SkillScope) => Promise<T>,
): Promise<(T & { success: true; scope: string }) | Failure> {
  try {
    const scope = requireScope(await scopesFor(ctx), requested);
    const result = await operation(requireSkillLifecycle(), scope);
    return { success: true, scope: scope.name, ...result };
  } catch (error) {
    return toFailure(error, failure);
  }
}

/** What a planner returns: the plan the tool runs, and what the approval rule judges. */
export interface ChangeOutline<TPlan> {
  readonly plan: TPlan;
  readonly changesLive: boolean;
  readonly targets: readonly SkillApprovalTarget[];
}

export interface PlanInput {
  readonly skills: SkillLifecycle;
  readonly scope: SkillScope;
  readonly scopes: readonly SkillScope[];
}

type Planner<TInput, TPlan> = (input: TInput, context: PlanInput) => Promise<ChangeOutline<TPlan>>;

type Change =
  | {
      readonly kind: "saved" | "published" | "mode";
      readonly skill: StoredSkill;
      readonly previous: SkillLiveState;
    }
  | { readonly kind: "removed"; readonly names: readonly string[] };

/** What running a change returns: the tool output and the change to report. */
export interface ChangeResult<T> {
  readonly output: T;
  readonly change?: Change;
}

/**
 * A lifecycle tool's approval and execution, built from one planner so the
 * approval rule judges exactly what the tool runs. The tool plans again when
 * it runs: if the change now needs a person and none approved it, `run` gets
 * `approved: false` and either holds the change back or refuses.
 */
export function skillChange<
  TInput extends { readonly scope?: string },
  TPlan,
  TOutput extends object,
>(input: {
  readonly action: SkillAction;
  readonly failure: string;
  readonly fallbackCard: (input: TInput) => string;
  readonly plan: Planner<TInput, TPlan>;
  readonly run: (
    plan: TPlan,
    context: PlanInput & {
      readonly approved: boolean;
      readonly ctx: SkillCallContext & { readonly callId: string };
    },
  ) => Promise<ChangeResult<TOutput>>;
}): {
  approval: ApprovalConfiguration<TInput>;
  execute: (
    toolInput: TInput,
    ctx: SkillCallContext & {
      readonly callId: string;
      readonly approval?: { readonly responder: SessionAuthContext };
    },
  ) => Promise<(TOutput & { success: true; scope: string }) | Failure>;
} {
  const plan = async (
    ctx: SkillCallContext,
    toolInput: TInput,
  ): Promise<PlannedChange<TPlan> & PlanInput> => {
    const skills = requireSkillLifecycle();
    const scopes = await scopesFor(ctx);
    const scope = requireScope(scopes, toolInput.scope);
    if (scope.readOnly) {
      throw new SkillChangeRefusedError(
        `The ${scope.name} skill scope is read-only here; its skills can be listed and loaded but not changed.`,
      );
    }
    const outline = await input.plan(toolInput, { skills, scope, scopes });
    return {
      skills,
      scope,
      scopes,
      plan: outline.plan,
      request: {
        action: input.action,
        scope,
        caller: ctx.session.auth.current,
        changesLive: outline.changesLive,
        targets: outline.targets,
      },
    };
  };
  const rule = () => skillConfig().approval.request ?? defaultSkillApproval;

  return {
    approval: skillApproval<TInput, TPlan>({
      plan: (ctx: ApprovalContext<TInput>, toolInput) => plan(ctx, toolInput),
      rule,
      response: () => skillConfig().approval.response ?? requesterOnly,
      fallbackCard: input.fallbackCard,
    }),
    async execute(toolInput, ctx) {
      try {
        const planned = await plan(ctx, toolInput);
        const decision = await rule()(planned.request);
        if (typeof decision === "object") throw new SkillChangeRefusedError(decision.deny);
        const approved = decision === "allow" || ctx.approval !== undefined;
        const { output, change } = await input.run(planned.plan, { ...planned, approved, ctx });
        if (change) await emit({ ...change, ...changeBase(planned.scope, ctx) });
        return { success: true, scope: planned.scope.name, ...output };
      } catch (error) {
        return toFailure(error, input.failure);
      }
    },
  };
}

function changeBase(
  scope: SkillScope,
  ctx: SkillCallContext & { readonly approval?: { readonly responder: SessionAuthContext } },
) {
  return {
    scope,
    actor: ctx.session.auth.current,
    sessionId: ctx.session.id,
    ...(ctx.approval !== undefined && { approvedBy: stripResponder(ctx.approval.responder) }),
  };
}

/** The responder's identity, without its credential accessor. */
function stripResponder(responder: SessionAuthContext): SessionAuthContext {
  const { getToken: _getToken, ...identity } = responder as SessionAuthContext & {
    getToken?: unknown;
  };
  return identity;
}

async function emit(event: SkillChangeEvent): Promise<void> {
  try {
    await skillConfig().onChange?.(event);
  } catch (error) {
    console.error("[custom-skills] onChange failed", error);
  }
}

/** Refuses a change that now needs approval nobody gave. */
export function requireApproval(approved: boolean): void {
  if (!approved) {
    throw new SkillChangeRefusedError(
      "This change needs approval now, because the skill changed since the call was planned. Call the tool again.",
    );
  }
}

/** The approval target for publishing or rolling back to `version`. */
export function publishTarget(
  name: string,
  { head, version }: { readonly head: SkillHead; readonly version: SkillVersionRecord },
): SkillApprovalTarget {
  return {
    name,
    version: version.version,
    description: version.description,
    instructions: version.markdown,
    applicationMode: version.applicationMode,
    warnings: version.validation.warnings,
    live: {
      version: head.liveVersion,
      applicationMode: head.liveVersion === null ? null : head.applicationMode,
    },
  };
}
