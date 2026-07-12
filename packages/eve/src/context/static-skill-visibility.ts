import type { ModelMessage } from "ai";

import type { CompiledModuleMap } from "#compiler/module-map.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import type { AlsContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { createLogger } from "#internal/logging.js";
import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { loadResolvedModuleExport } from "#runtime/resolve-helpers.js";
import type { ResolvedStaticSkillVisibilityReference } from "#runtime/types.js";
import { toErrorMessage } from "#shared/errors.js";

const log = createLogger("static-skill-visibility");

export interface StaticSkillVisibilityState {
  readonly kind: "all" | "subset";
  readonly names: readonly string[];
}

export const StaticSkillVisibilityKey = new ContextKey<StaticSkillVisibilityState>(
  "eve.staticSkillVisibility",
);

export function initializeStaticSkillVisibility(
  ctx: AlsContext,
  staticSkillNames: readonly string[],
): void {
  const currentNames = [...staticSkillNames];
  const currentNameSet = new Set(currentNames);
  const existing = ctx.get(StaticSkillVisibilityKey);

  if (existing?.kind === "subset") {
    ctx.set(StaticSkillVisibilityKey, {
      kind: "subset",
      names: existing.names.filter((name) => currentNameSet.has(name)),
    });
    return;
  }

  // `all` is an authorization mode, not a cached inventory. Refreshing its
  // names keeps prompt projection and load_skill authorization aligned when a
  // durable continuation encounters a changed compiled skill catalog.
  ctx.set(StaticSkillVisibilityKey, { kind: "all", names: currentNames });
}

export function filterVisibleStaticSkills<T extends { readonly name: string }>(
  skills: readonly T[] | undefined,
  visibility: StaticSkillVisibilityState | undefined,
): readonly T[] {
  if (skills === undefined || visibility === undefined || visibility.kind === "all") {
    return skills ?? [];
  }

  const visible = new Set(visibility.names);
  return skills.filter((skill) => visible.has(skill.name));
}

export function getVisibleStaticSkillNames(ctx: {
  get<T>(key: ContextKey<T>): T | undefined;
}): readonly string[] | undefined {
  return ctx.get(StaticSkillVisibilityKey)?.names;
}

export async function dispatchStaticSkillVisibilityEvent(input: {
  readonly ctx: AlsContext;
  readonly event: HandleMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
  readonly resolver: ResolvedStaticSkillVisibilityReference | undefined;
  readonly scope: {
    readonly moduleMap: CompiledModuleMap;
    readonly nodeId: string | undefined;
  };
  readonly staticSkillNames: readonly string[];
}): Promise<void> {
  if (input.resolver === undefined) return;
  if (input.event.type !== "session.started" && input.event.type !== "turn.started") return;
  if (!input.resolver.eventNames.includes(input.event.type)) return;

  try {
    const definition = await loadResolvedModuleExport({
      definition: input.resolver,
      kindLabel: "static skill visibility",
      moduleMap: input.scope.moduleMap,
      nodeId: input.scope.nodeId,
    });
    const normalized = normalizeAgentDefinition(
      definition,
      `Expected the authored agent config export "${input.resolver.exportName ?? "default"}" from "${input.resolver.logicalPath}" to match the public eve shape.`,
    );
    const visibility = normalized.staticSkillVisibility;
    if (visibility === undefined) {
      throw new Error("The compiled static skill visibility source no longer exports a resolver.");
    }
    const handler = visibility.events[input.event.type];
    if (handler === undefined) return;

    const result = await handler(input.event, buildResolveContext(input.ctx, input.messages));
    input.ctx.set(
      StaticSkillVisibilityKey,
      normalizeStaticSkillVisibilityResult(result, input.staticSkillNames),
    );
  } catch (error) {
    log.error(`Static skill visibility resolver (${input.event.type}) failed closed.`, {
      error: toErrorMessage(error),
    });
    input.ctx.set(StaticSkillVisibilityKey, { kind: "subset", names: [] });
  }
}

function normalizeStaticSkillVisibilityResult(
  result: unknown,
  staticSkillNames: readonly string[],
): StaticSkillVisibilityState {
  if (result === "all") {
    return { kind: "all", names: [...staticSkillNames] };
  }

  if (!Array.isArray(result) || !result.every((name): name is string => typeof name === "string")) {
    throw new Error('Expected static skill visibility to return "all" or an array of skill names.');
  }

  const knownNames = new Set(staticSkillNames);
  const selectedNames = new Set(result);
  if (selectedNames.size !== result.length) {
    throw new Error("Static skill visibility returned duplicate skill names.");
  }
  const unknownNames = result.filter((name) => !knownNames.has(name));
  if (unknownNames.length > 0) {
    throw new Error(
      `Static skill visibility returned unknown skill names: ${unknownNames.join(", ")}.`,
    );
  }

  return { kind: "subset", names: [...result] };
}
