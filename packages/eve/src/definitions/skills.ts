import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import {
  DynamicSkillSandboxKey,
  SandboxKey,
  type DurableDynamicSkillMetadata,
} from "#context/keys.js";
import { SKILL_NAME_PATTERN, SKILL_NAME_RULE } from "#shared/name-grammar.js";
import { declared, type ResolvedDynamicDefinition } from "#runtime/types.js";
import type { SandboxState } from "#sandbox/state.js";
import { parseJsonValue } from "#shared/json.js";
import { isBrandedSkillEntry, type SkillPackageDefinition } from "#shared/skill-definition.js";
import {
  type MaterializableSkillPackage,
  normalizeSkillPackage,
  removeSkillPackageFromSandbox,
  skillPackageRevision,
  stripSkillFrontmatter,
  writeSkillPackageToSandbox,
} from "#shared/skill-package.js";
import { formatAvailableSkillsSection, skillFilePath } from "#execution/skills/instructions.js";
import { compiledBundleOf } from "#runtime/sessions/runtime-context-keys.js";
import { slotsOf, slotValueOf } from "#definitions/state.js";
import { namedEntries, type EntryKind } from "./named.js";
import {
  authoredEvaluate,
  type Definition,
  type Section,
  section,
  SECTION_ORDER,
} from "./definition.js";

/**
 * The agent's own skills: each joins the call's skills, after the dynamic ones, which take a name
 * from them; the ones that aren't deferred are listed in eve's default prompt, as the call has
 * them.
 */
export const skills: Definition = {
  contribute: ({ container }) => {
    const own = compiledBundleOf(container)?.resolvedAgent.skills ?? [];
    return {
      tools: () => ({
        skills: new Map(
          own.map((skill) => [
            skill.name,
            {
              deferred: skill.deferred === true,
              description: skill.description,
              markdown: skill.content,
              name: skill.name,
              path: skillFilePath(skill.name),
            },
          ]),
        ),
      }),
      arrange: (draft) => ({
        system: async () => {
          const names = new Set(own.map(({ name }) => name));
          const listed = skillsSection(
            [...(await draft.tools()).skills.values()].filter(({ name }) => names.has(name)),
          );
          return [...(await draft.system()), ...(listed === undefined ? [] : [listed])];
        },
      }),
    };
  },
  id: "eve.skills",
  label: "the agent's skills",
};

/** The listing of `skills` in eve's default prompt: those that aren't deferred. */
function skillsSection(
  skills: readonly {
    readonly name: string;
    readonly description: string;
    readonly deferred?: boolean;
  }[],
): Section | undefined {
  const listed = formatAvailableSkillsSection(
    skills
      .filter((skill) => skill.deferred !== true)
      .map(({ description, name }) => ({ description, name })),
  );
  return listed === null
    ? undefined
    : section("eve.skills", listed, { order: SECTION_ORDER.skills });
}

/**
 * A `defineDynamic()` in `agent/skills/`: one skill named after the file, or a map of them. It
 * keeps what the model sees: each skill's name, description, markdown, and a revision of its
 * files, and each joins the call's skills. The files themselves are built again wherever a
 * sandbox needs them, not stored.
 */
export function skillDefinition(resolver: ResolvedDynamicDefinition<"skill">): Definition {
  const id = skillId(resolver);
  const evaluate = authoredEvaluate(resolver.evaluate);
  return {
    contribute: (ctx) => ({
      tools: async () => {
        const kept = await ctx.keep(async (evaluation) => {
          const skills = namedEntries(resolver, await evaluate(evaluation), SKILLS).map(
            ({ entry, name }) =>
              normalizeSkillPackage({ ...(entry as SkillPackageDefinition), name }),
          );
          if (skills.length === 0) return null;
          const withFiles = skills.filter((skill) => skill.files.length > 1);
          return {
            value: parseJsonValue(skills.map(toDurableSkill)),
            ...(withFiles.length > 0 && { live: withFiles }),
          };
        });
        const own = slotValueOf<readonly DurableDynamicSkillMetadata[] | null>(kept?.value ?? null);
        return {
          skills: new Map(
            (own ?? []).map((skill) => [
              skill.name,
              {
                deferred: skill.deferred === true,
                description: skill.description,
                markdown: stripSkillFrontmatter(skill.markdown),
                name: skill.name,
                path: skill.revision === undefined ? undefined : skillFilePath(skill.name),
                source: id,
              },
            ]),
          ),
        };
      },
    }),
    id,
    install: syncDynamicSkillFiles,
    label: resolver.logicalPath,
  };
}

/**
 * Each dynamic skill definition's kept skills, read by kind, for writing their files: when two
 * name the same skill, the first keeps it, as it does in the call, so the sandbox holds the files
 * of the skill whose metadata the model sees.
 */
function ownedSkills(ctx: Pick<ContextReader, "get">): {
  readonly id: string;
  readonly live?: unknown;
  readonly skills: DurableDynamicSkillMetadata[];
}[] {
  const bundle = compiledBundleOf(ctx);
  if (bundle === undefined) return [];
  const owners = new Set<string>();
  const slots = new Map(slotsOf(ctx, "skill").map((slot) => [slot.id, slot]));
  return declared(bundle.resolvedAgent, "skill").flatMap((resolver) => {
    const kept = slots.get(skillId(resolver));
    if (kept === undefined) return [];
    const { id, live, slot } = kept;
    return [
      {
        id,
        live,
        skills: (
          slotValueOf<readonly DurableDynamicSkillMetadata[] | null>(slot.value) ?? []
        ).filter((skill) => {
          if (owners.has(skill.name)) return false;
          owners.add(skill.name);
          return true;
        }),
      },
    ];
  });
}

/**
 * Queues the writes of skills with supporting files, so the model call never waits for the
 * sandbox; anything that uses the sandbox waits for them. A package already written at its
 * revision to the same sandbox is skipped, and a session with nothing to write or withdraw never
 * touches the sandbox.
 *
 * Files are removed only when no slot holds a skill by that name anymore. A skill that stops
 * returning supporting files keeps them, since the sandbox may already provide them, for example
 * from its snapshot.
 */
export async function syncDynamicSkillFiles(ctx: ContextContainer): Promise<void> {
  const access = ctx.get(SandboxKey);
  if (access === undefined) return;
  const kept = new Set<string>();
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
      kept.add(skill.name);
      if (skill.revision === undefined) continue;
      desired.set(skill.name, skill.revision);
      const files = rendered.get(skill.name)?.files;
      // A package this step couldn't build again waits for the next model call.
      if (files === undefined) continue;
      packages.set(skill.name, {
        description: skill.description,
        files,
        content: skill.markdown,
        name: skill.name,
      });
    }
  }
  // Markdown-only skills never need a sandbox.
  if (desired.size === 0 && Object.keys(ctx.get(DynamicSkillSandboxKey) ?? {}).length === 0) {
    return;
  }

  access.prepare(async (open) => {
    // Read when the work runs: earlier work queued in this step may have changed it. The written
    // record, not the slots, finds withdrawn files: a skill that went markdown-only has no
    // revision left, but its files are still there.
    const written = ctx.get(DynamicSkillSandboxKey) ?? {};
    const identity = sandboxIdentity(await access.captureState());
    const mark = (name: string) => `${identity}#${desired.get(name) ?? ""}`;
    const withdrawn = Object.keys(written).filter((name) => !kept.has(name));
    // Files written to another sandbox aren't in this one to remove.
    const stale = withdrawn.filter(
      (name) => identity !== null && written[name]?.startsWith(`${identity}#`) === true,
    );
    const pending = [...desired.keys()].filter(
      (name) => packages.has(name) && (identity === null || written[name] !== mark(name)),
    );
    if (withdrawn.length === 0 && pending.length === 0) return;

    const next = { ...written };
    for (const name of withdrawn) if (!stale.includes(name)) delete next[name];
    if (stale.length === 0 && pending.length === 0) {
      ctx.set(DynamicSkillSandboxKey, next);
      return;
    }
    const sandbox = await open();
    for (const name of stale) {
      await removeSkillPackageFromSandbox({ name, sandbox });
      delete next[name];
    }
    for (const name of pending) {
      const skill = packages.get(name);
      if (skill === undefined) continue;
      // Forget the package first so a failed write is redone by the next model call.
      delete next[name];
      ctx.set(DynamicSkillSandboxKey, { ...next });
      // Replace the directory so files omitted from the new revision disappear.
      await removeSkillPackageFromSandbox({ name, sandbox });
      await writeSkillPackageToSandbox({ sandbox, skill });
      const current = sandboxIdentity(await access.captureState());
      if (current !== null) next[name] = `${current}#${desired.get(name)}`;
    }
    ctx.set(DynamicSkillSandboxKey, next);
  });
}

function skillId(resolver: ResolvedDynamicDefinition<"skill">): string {
  return `skill:${resolver.extensionNamespace ?? ""}:${resolver.slug}`;
}

const SKILLS: EntryKind = {
  is: isBrandedSkillEntry,
  made: "defineSkill()",
  noun: "skill",
  pattern: SKILL_NAME_PATTERN,
  qualifiedPattern: SKILL_NAME_PATTERN,
  rule: SKILL_NAME_RULE,
};

function toDurableSkill(skill: MaterializableSkillPackage): DurableDynamicSkillMetadata {
  const durable: {
    -readonly [K in keyof DurableDynamicSkillMetadata]: DurableDynamicSkillMetadata[K];
  } = { markdown: skill.content, description: skill.description, name: skill.name };
  if (skill.deferred === true) durable.deferred = true;
  // A package's files are built again where a sandbox needs them; the slot keeps their revision.
  if (skill.files.length > 1) durable.revision = skillPackageRevision(skill);
  return durable;
}

// The whole persisted record, including the generation `start()` sets: provider state alone
// repeats when a gone sandbox is recreated under the same name.
function sandboxIdentity(state: SandboxState): string | null {
  return state.session === null ? null : JSON.stringify(state.session);
}
