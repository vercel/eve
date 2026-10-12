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
import { parseJsonValue } from "#shared/json.js";
import { isBrandedSkillEntry, type SkillPackageDefinition } from "#shared/skill-definition.js";
import {
  type MaterializableSkillPackage,
  normalizeSkillPackage,
  removeSkillPackageFromSandbox,
  skillPackageRevision,
  writeSkillPackageToSandbox,
} from "#shared/skill-package.js";
import { authoredRender, authoredRecord, type Reaction } from "../reaction.js";
import { slotsOf } from "../state.js";
import { slotValueOf } from "../state.js";

const log = createLogger("dynamic-skills");

/**
 * A `defineDynamic()` in `agent/skills/`: one skill named after the file, or a map of them. The
 * slot records what the model sees: each skill's name, description, markdown, and a revision of
 * its files. Files `render` makes are rendered again wherever a sandbox needs them, not stored;
 * files `record` returns, without a render, are in the record.
 */
export function skillReaction(resolver: ResolvedDynamicSkillResolver): Reaction {
  const framework = { framework: resolver.framework };
  const rendered = resolver.render !== undefined;
  return {
    render: authoredRender(resolver.logicalPath, resolver.render, framework),
    contribute: (result) => {
      const skills = namedSkills(resolver, result).map(({ entry, name }) =>
        normalizeSkillPackage({ ...entry, name }),
      );
      if (skills.length === 0) return { value: null };
      const value = skills.map((skill) => toDurableSkill(skill, { files: !rendered }));
      const withFiles = skills.filter((skill) => skill.files.length > 1);
      return {
        value: parseJsonValue(value),
        ...(rendered && withFiles.length > 0 && { live: withFiles }),
      };
    },
    id: `skill:${resolver.extensionNamespace ?? ""}:${resolver.slug}`,
    kind: "skill",
    label: resolver.logicalPath,
    record: authoredRecord(resolver.logicalPath, resolver.record, framework),
    select: resolver.select as Reaction["select"],
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
  for (const { id, skills } of ownedSkills(ctx, (name, id, owner) =>
    log.error(`Dynamic skill "${name}" from "${id}" collides with "${owner}".`),
  )) {
    if (skills.length > 0) manifest[id] = skills;
  }
  return manifest;
}

/**
 * Each skill slot with the skills it keeps: when two slots name the same skill, the first keeps
 * it. The manifest and the sandbox both read this, so the model sees the metadata of the skill
 * whose files the sandbox holds.
 */
function ownedSkills(
  ctx: Pick<ContextReader, "get"> | undefined,
  onCollision?: (name: string, id: string, owner: string) => void,
): {
  readonly id: string;
  readonly live?: unknown;
  readonly skills: DurableDynamicSkillMetadata[];
}[] {
  const owners = new Map<string, string>();
  return slotsOf(ctx, "skill").map(({ id, live, slot }) => ({
    id,
    live,
    skills: (slotValueOf<readonly DurableDynamicSkillMetadata[] | null>(slot.value) ?? []).filter(
      (skill) => {
        const owner = owners.get(skill.name);
        if (owner === undefined) {
          owners.set(skill.name, id);
          return true;
        }
        onCollision?.(skill.name, id, owner);
        return false;
      },
    ),
  }));
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
  for (const { live, skills } of ownedSkills(ctx)) {
    const rendered = new Map(
      ((live as readonly MaterializableSkillPackage[] | undefined) ?? []).map((skill) => [
        skill.name,
        skill,
      ]),
    );
    for (const skill of skills) {
      if (skill.revision === undefined) continue;
      desired.set(skill.name, skill.revision);
      const files =
        rendered.get(skill.name)?.files ??
        skill.files?.map(({ content, relativePath }) => ({
          content: Buffer.from(content, "base64"),
          relativePath,
        }));
      // A rendered package this step couldn't render again waits for the next model call.
      if (files === undefined) continue;
      packages.set(skill.name, {
        description: skill.description,
        files,
        markdown: skill.markdown,
        name: skill.name,
      });
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
        `The defineDynamic() in "${resolver.logicalPath}" returned the reserved skill name "${name}". ${reservation}; rename the skill.`,
      );
    }
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new Error(
        `The defineDynamic() in "${resolver.logicalPath}" returned illegal skill name "${name}". ${SKILL_NAME_RULE}`,
      );
    }
    return { entry, name };
  });
}

function toDurableSkill(
  skill: MaterializableSkillPackage,
  options: { readonly files: boolean },
): DurableDynamicSkillMetadata {
  const durable: {
    -readonly [K in keyof DurableDynamicSkillMetadata]: DurableDynamicSkillMetadata[K];
  } = { description: skill.description, markdown: skill.markdown, name: skill.name };
  if (skill.deferred === true) durable.deferred = true;
  if (skill.files.length > 1) {
    // Files a render makes are rendered again where a sandbox needs them; only recorded ones stay.
    if (options.files) {
      durable.files = skill.files.map(({ content, relativePath }) => ({
        content: content.toString("base64"),
        relativePath,
      }));
    }
    durable.revision = skillPackageRevision(skill);
  }
  return durable;
}

function sandboxIdentity(state: SandboxState): string | null {
  return state.session === null ? null : JSON.stringify(state.session);
}
