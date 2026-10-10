import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import {
  DynamicSkillSandboxKey,
  SandboxKey,
  type DurableDynamicSkillMetadata,
  type DynamicSkillManifest,
} from "#context/keys.js";
import { SKILL_NAME_PATTERN, SKILL_NAME_RULE } from "#discover/grammar.js";
import { createLogger } from "#internal/logging.js";
import { eveNamespaceReservation } from "#protocol/runtime-tools.js";
import type { ResolvedDynamicSkillResolver } from "#runtime/types.js";
import type { SandboxState } from "#sandbox/state.js";
import type { JsonValue } from "#shared/json.js";
import { isBrandedSkillEntry, type SkillPackageDefinition } from "#shared/skill-definition.js";
import {
  type MaterializableSkillPackage,
  normalizeSkillPackage,
  removeSkillPackageFromSandbox,
  skillPackageRevision,
  writeSkillPackageToSandbox,
} from "#shared/skill-package.js";
import type { Reaction } from "../reaction.js";
import { slotsOf } from "../runner.js";

const log = createLogger("dynamic-skills");

/**
 * A `defineDynamic()` in `agent/skills/`: one skill named after the file, or a map of them. Skills
 * with supporting files keep their package as code, so a step can write it to the sandbox.
 */
export function skillReaction(resolver: ResolvedDynamicSkillResolver): Reaction {
  return {
    contribute: (result) => {
      const skills = namedSkills(resolver, result).map(({ entry, name }) =>
        normalizeSkillPackage({ ...entry, name }),
      );
      if (skills.length === 0) return { value: null };
      const packaged = skills.filter((skill) => skill.files.length > 1);
      return {
        ...(packaged.length === 0 ? {} : { live: packaged }),
        value: skills.map(toDurableSkill) as unknown as JsonValue,
      };
    },
    id: `skill:${resolver.extensionNamespace ?? ""}:${resolver.slug}`,
    kind: "skill",
    label: resolver.logicalPath,
    resolve: resolver.resolve as Reaction["resolve"],
    ...(resolver.select === undefined ? {} : { select: resolver.select as Reaction["select"] }),
  };
}

/**
 * The dynamic skills the session's slots hold, by reaction. A dynamic skill overrides a same-named
 * authored one; when two reactions name the same skill, the first keeps it.
 */
export function dynamicSkillManifest(
  ctx: Pick<ContextReader, "get"> | undefined,
): DynamicSkillManifest {
  const manifest: Record<string, readonly DurableDynamicSkillMetadata[]> = {};
  const owners = new Map<string, string>();
  for (const { id, slot } of slotsOf(ctx, "skill")) {
    const skills = ((slot.value ?? []) as unknown as readonly DurableDynamicSkillMetadata[]).filter(
      (skill) => {
        const owner = owners.get(skill.name);
        if (owner === undefined) {
          owners.set(skill.name, id);
          return true;
        }
        log.error(`Dynamic skill "${skill.name}" from "${id}" collides with "${owner}".`);
        return false;
      },
    );
    if (skills.length > 0) manifest[id] = skills;
  }
  return manifest;
}

/**
 * Writes the packages of skills with supporting files to the sandbox, and removes the ones no slot
 * holds anymore. A package already written at its revision to the same sandbox is skipped.
 */
export async function syncDynamicSkillFiles(ctx: ContextContainer): Promise<void> {
  const access = ctx.get(SandboxKey);
  if (access === undefined) return;
  const desired = new Map<string, string>();
  const packages = new Map<string, MaterializableSkillPackage>();
  for (const { live, slot } of slotsOf(ctx, "skill")) {
    for (const skill of (slot.value ?? []) as unknown as readonly DurableDynamicSkillMetadata[]) {
      if (skill.revision !== undefined) desired.set(skill.name, skill.revision);
    }
    for (const skill of (live as readonly MaterializableSkillPackage[] | undefined) ?? []) {
      packages.set(skill.name, skill);
    }
  }
  const written = ctx.get(DynamicSkillSandboxKey) ?? {};
  const identity = sandboxIdentity(await access.captureState());
  const mark = (name: string) => `${identity}#${desired.get(name) ?? ""}`;
  const stale = Object.keys(written).filter((name) => !desired.has(name));
  const pending = [...desired.keys()].filter(
    (name) => identity === null || written[name] !== mark(name),
  );
  if (stale.length === 0 && pending.length === 0) return;

  const sandbox = await access.get();
  if (sandbox === null) return;
  const next = { ...written };
  for (const name of stale) {
    await removeSkillPackageFromSandbox({ name, sandbox });
    delete next[name];
  }
  for (const name of pending) {
    const skill = packages.get(name);
    if (skill === undefined) continue;
    delete next[name];
    ctx.set(DynamicSkillSandboxKey, { ...next });
    // Replace the directory so files omitted from the new revision disappear.
    await removeSkillPackageFromSandbox({ name, sandbox });
    await writeSkillPackageToSandbox({ sandbox, skill });
    const current = sandboxIdentity(await access.captureState());
    if (current !== null) next[name] = `${current}#${desired.get(name)}`;
  }
  ctx.set(DynamicSkillSandboxKey, next);
}

function namedSkills(
  resolver: ResolvedDynamicSkillResolver,
  result: unknown,
): readonly { readonly name: string; readonly entry: SkillPackageDefinition }[] {
  if (result === null || result === undefined) return [];
  const isSingle = isBrandedSkillEntry(result);
  const entries = isSingle
    ? { _single: result as SkillPackageDefinition }
    : (result as Record<string, SkillPackageDefinition>);
  const prefix =
    resolver.extensionNamespace === undefined ? "" : `${resolver.extensionNamespace}__`;
  return Object.entries(entries).map(([key, entry]) => {
    const name = isSingle ? resolver.slug : `${prefix}${key}`;
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
    return { entry, name };
  });
}

function toDurableSkill(skill: MaterializableSkillPackage): DurableDynamicSkillMetadata {
  return {
    ...(skill.deferred === true ? { deferred: true } : {}),
    description: skill.description,
    markdown: skill.markdown,
    name: skill.name,
    ...(skill.files.length > 1 ? { revision: skillPackageRevision(skill) } : {}),
  };
}

function sandboxIdentity(state: SandboxState): string | null {
  return state.session === null ? null : JSON.stringify(state.session);
}
