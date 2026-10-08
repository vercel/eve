import type { ModelMessage } from "ai";

import { SKILL_NAME_PATTERN, SKILL_NAME_RULE } from "#discover/grammar.js";
import type { DynamicSessionOrTurnEvent } from "#dynamic/definition.js";
import { isBrandedSkillEntry, type SkillPackageDefinition } from "#shared/skill-definition.js";
import {
  type MaterializableSkillPackage,
  normalizeSkillPackage,
  removeSkillPackageFromSandbox,
  skillPackageRevision,
  writeSkillPackageToSandbox,
} from "#shared/skill-package.js";
import { eveNamespaceReservation } from "#protocol/runtime-tools.js";
import type { ResolvedDynamicSkillResolver } from "#runtime/types.js";
import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ContextContainer } from "#context/container.js";
import {
  type DurableDynamicSkillMetadata,
  DynamicSkillManifestKey,
  DynamicSkillSandboxKey,
  SandboxKey,
} from "#context/keys.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import type { SandboxState } from "#sandbox/state.js";

const log = createLogger("dynamic-skills");

// ---------------------------------------------------------------------------
// Name qualification
// ---------------------------------------------------------------------------

function qualifyDynamicSkillNames(
  resolver: ResolvedDynamicSkillResolver,
  isSingle: boolean,
  entries: Readonly<Record<string, SkillPackageDefinition>>,
): Array<{ name: string; entry: SkillPackageDefinition }> {
  // A single returned defineSkill is named after the file slug (already
  // namespaced for an extension). A map names each entry by its bare key,
  // prefixed with the mount namespace for an extension resolver.
  const prefix =
    resolver.extensionNamespace !== undefined ? `${resolver.extensionNamespace}__` : "";
  const named = Object.entries(entries).map(([key, entry]) => ({
    entry,
    name: isSingle ? resolver.slug : `${prefix}${key}`,
  }));
  for (const { name } of named) {
    const reservation = eveNamespaceReservation(name);
    if (reservation !== undefined) {
      throw new Error(
        `Dynamic skill resolver "${resolver.logicalPath}" returned the reserved skill name "${name}". ${reservation}; rename the skill.`,
      );
    }
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new Error(
        `Dynamic skill resolver "${resolver.logicalPath}" returned illegal skill name "${name}". ${SKILL_NAME_RULE}`,
      );
    }
  }
  return named;
}

interface DynamicSkillUpdate {
  readonly resolver: ResolvedDynamicSkillResolver;
  readonly skills: readonly MaterializableSkillPackage[];
}

interface DynamicSkillResolution {
  readonly resolver: ResolvedDynamicSkillResolver;
  readonly named: readonly { name: string; entry: SkillPackageDefinition }[];
}

interface SandboxSkillPackage {
  readonly revision: string;
  readonly skill: MaterializableSkillPackage;
}

function toDurableSkill(skill: MaterializableSkillPackage): DurableDynamicSkillMetadata {
  return {
    deferred: skill.deferred === true ? true : undefined,
    description: skill.description,
    markdown: skill.markdown,
    name: skill.name,
    ...(skill.files.length > 1 ? { revision: skillPackageRevision(skill) } : {}),
  };
}

function sandboxIdentity(state: SandboxState): string | null {
  return state.session === null ? null : JSON.stringify(state.session);
}

/**
 * Writes only packages with supporting files. Markdown-only skills are served
 * from durable context, so they never need a sandbox. A package is skipped when
 * its revision is unchanged and was written to the same persisted sandbox.
 */
async function syncDynamicSkillFiles(input: {
  readonly ctx: ContextContainer;
  readonly previous: ReadonlyMap<string, string>;
  readonly next: ReadonlyMap<string, SandboxSkillPackage>;
}): Promise<void> {
  const { ctx, previous, next } = input;
  if (previous.size === 0 && next.size === 0) return;

  const access = ctx.require(SandboxKey);
  const written = ctx.get(DynamicSkillSandboxKey) ?? {};
  const identity = sandboxIdentity(await access.captureState());
  const isWritten = (name: string) => identity !== null && written[name] === identity;

  const stale = [...previous.keys()].filter((name) => !next.has(name) && isWritten(name));
  const pending = [...next.values()].filter(
    ({ revision, skill }) => previous.get(skill.name) !== revision || !isWritten(skill.name),
  );
  if (stale.length === 0 && pending.length === 0) return;

  const sandbox = await access.get();
  if (sandbox === null) return;

  // Forget touched packages first so a failed write is never skipped later.
  const nextWritten = { ...written };
  for (const name of previous.keys()) {
    if (!next.has(name)) delete nextWritten[name];
  }
  for (const { skill } of pending) delete nextWritten[skill.name];
  ctx.set(DynamicSkillSandboxKey, { ...nextWritten });

  for (const name of stale) {
    await removeSkillPackageFromSandbox({ name, sandbox });
  }
  const current = sandboxIdentity(await access.captureState());
  for (const { skill } of pending) {
    // Replace the directory so files omitted from the new revision disappear.
    await removeSkillPackageFromSandbox({ name: skill.name, sandbox });
    await writeSkillPackageToSandbox({ sandbox, skill });
    if (current !== null) nextWritten[skill.name] = current;
  }
  ctx.set(DynamicSkillSandboxKey, nextWritten);
}

// ---------------------------------------------------------------------------
// Event dispatch
// ---------------------------------------------------------------------------

/**
 * Runs the dynamic skill resolvers for a session or a turn: stores their instructions in durable
 * context and syncs changed supporting files to the sandbox.
 */
export async function resolveDynamicSkills(input: {
  readonly ctx: ContextContainer;
  readonly resolvers: readonly ResolvedDynamicSkillResolver[];
  readonly event: DynamicSessionOrTurnEvent;
  readonly messages: readonly ModelMessage[];
}): Promise<void> {
  const { ctx, resolvers, event, messages } = input;
  const matching = resolvers.filter((r) => r.eventNames.includes(event.type));
  if (matching.length === 0) return;

  const resolveCtx = buildResolveContext(ctx, messages);
  const manifest = ctx.get(DynamicSkillManifestKey) ?? {};
  const updates: DynamicSkillUpdate[] = [];

  const outcomes = await Promise.allSettled(
    matching.map(async (resolver) => {
      const handler = resolver.events[event.type];
      if (handler === undefined) return null;

      const rawResult = await handler(event, resolveCtx);
      if (rawResult === null || rawResult === undefined) return { resolver, named: [] };

      let entries: Record<string, SkillPackageDefinition>;
      let isSingle: boolean;
      if (isBrandedSkillEntry(rawResult)) {
        entries = { _single: rawResult as SkillPackageDefinition };
        isSingle = true;
      } else {
        entries = rawResult as Record<string, SkillPackageDefinition>;
        isSingle = false;
      }

      const named = qualifyDynamicSkillNames(resolver, isSingle, entries);
      return { resolver, named } satisfies DynamicSkillResolution;
    }),
  );

  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      log.error(`Dynamic skill resolver (${event.type}) threw — skipping.`, {
        error: toErrorMessage(outcome.reason),
      });
      continue;
    }
    if (outcome.value === null) continue;
    updates.push({
      resolver: outcome.value.resolver,
      skills: outcome.value.named.map(({ name, entry }) =>
        normalizeSkillPackage({ ...entry, name }),
      ),
    });
  }

  if (updates.length === 0) return;

  // Only resolvers that just ran are synced; package bytes for the others
  // are not retained across steps.
  const newManifest = { ...manifest };
  const previous = new Map<string, string>();
  const next = new Map<string, SandboxSkillPackage>();
  for (const { resolver, skills } of updates) {
    for (const { name, revision } of manifest[resolver.slug] ?? []) {
      if (revision !== undefined) previous.set(name, revision);
    }
    if (skills.length === 0) {
      delete newManifest[resolver.slug];
      continue;
    }
    newManifest[resolver.slug] = skills.map((skill) => {
      const durable = toDurableSkill(skill);
      if (durable.revision !== undefined) {
        next.set(skill.name, { revision: durable.revision, skill });
      }
      return durable;
    });
  }

  // A dynamic skill whose name matches an authored skill overrides it:
  // loading prefers the dynamic body, and supporting files replace the
  // authored package at the same sandbox path. Two dynamic resolvers
  // emitting the same name is a genuine ambiguity and still throws.
  const dynamicSkillOwners = new Map<string, string>();
  for (const [resolverSlug, skills] of Object.entries(newManifest)) {
    for (const { name } of skills) {
      const previousOwner = dynamicSkillOwners.get(name);
      if (previousOwner !== undefined) {
        throw new Error(
          `Dynamic skill "${name}" from resolver "${resolverSlug}" collides with dynamic resolver "${previousOwner}". Namespace the map key manually, e.g. "${resolverSlug}__${name}".`,
        );
      }
      dynamicSkillOwners.set(name, resolverSlug);
    }
  }

  await syncDynamicSkillFiles({ ctx, next, previous });

  ctx.set(DynamicSkillManifestKey, newManifest);
}
