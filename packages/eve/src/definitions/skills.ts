import type { AgentSourceOwner } from "#compiler/source-graph.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import {
  DynamicSkillSandboxKey,
  SandboxKey,
  type DurableDynamicSkillMetadata,
} from "#context/keys.js";
import { SKILL_NAME_PATTERN, SKILL_NAME_RULE } from "#discover/grammar.js";
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
import { announcementDigest } from "#harness/announcements.js";
import { owningSandboxDefinition } from "#runtime/sandbox/registry.js";
import { compiledBundleOf } from "#runtime/sessions/runtime-context-keys.js";
import { MODEL_HOST_SKILL_ROOT, MODEL_SKILL_ROOT } from "#shared/skill-paths.js";
import { slotsOf, slotValueOf } from "#definitions/state.js";
import { namedEntries, type EntryKind } from "./named.js";
import {
  authoredEvaluate,
  type Definition,
  type Section,
  section,
  SECTION_ORDER,
} from "./definition.js";

export function modelSkillRootOf(container: Pick<ContextReader, "get">): string {
  const bundle = compiledBundleOf(container);
  if (bundle === undefined) return MODEL_SKILL_ROOT;
  const registered = bundle.graph?.root?.sandboxRegistry?.sandbox;
  const sandbox =
    registered != null ? owningSandboxDefinition(registered) : bundle.resolvedAgent?.sandbox;
  return sandbox?.kind === "independent" && sandbox.environment.provider === "host"
    ? MODEL_HOST_SKILL_ROOT
    : MODEL_SKILL_ROOT;
}

export const skills: Definition = {
  contribute: ({ container }) => {
    const bundle = compiledBundleOf(container);
    const own = bundle?.resolvedAgent.skills ?? [];
    const nodeId = bundle?.nodeId ?? null;
    const skillRoot = modelSkillRootOf(container);
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
              path: skillFilePath(skill.name, skillRoot),
              provenance:
                skill.owner === undefined
                  ? undefined
                  : {
                      identity: skill.sourceId,
                      revision: announcementDigest("skill", skill.content),
                      scope: staticSkillScope(skill.owner, nodeId),
                    },
            },
          ]),
        ),
      }),
      arrange: (draft) => ({
        system: async () => {
          const names = new Set(own.map(({ name }) => name));
          const listed = skillsSection(
            [...(await draft.tools()).skills.values()].filter(({ name }) => names.has(name)),
            skillRoot,
          );
          return [...(await draft.system()), ...(listed === undefined ? [] : [listed])];
        },
      }),
    };
  },
  id: "eve.skills",
  label: "the agent's skills",
};

function staticSkillScope(owner: AgentSourceOwner, nodeId: string | null): string {
  switch (owner.kind) {
    case "application":
      return JSON.stringify([owner.kind, nodeId]);
    case "extension":
      return JSON.stringify([owner.kind, nodeId, owner.mountId, owner.packageName]);
    case "framework":
      return JSON.stringify([owner.kind, nodeId, owner.feature]);
  }
}

function skillsSection(
  skills: readonly {
    readonly name: string;
    readonly description: string;
    readonly deferred?: boolean;
  }[],
  skillRoot: string,
): Section | undefined {
  const listed = formatAvailableSkillsSection(
    skills
      .filter((skill) => skill.deferred !== true)
      .map(({ description, name }) => ({ description, name })),
    { skillRoot },
  );
  return listed === null
    ? undefined
    : section("eve.skills", listed, { order: SECTION_ORDER.skills });
}

export function skillDefinition(resolver: ResolvedDynamicDefinition<"skill">): Definition {
  const id = skillId(resolver);
  const evaluate = authoredEvaluate(resolver.evaluate);
  return {
    contribute: (ctx) => {
      const skillRoot = modelSkillRootOf(ctx.container);
      return {
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
          const own = slotValueOf<readonly DurableDynamicSkillMetadata[] | null>(
            kept?.value ?? null,
          );
          return {
            skills: new Map(
              (own ?? []).map((skill) => [
                skill.name,
                {
                  deferred: skill.deferred === true,
                  description: skill.description,
                  markdown: stripSkillFrontmatter(skill.markdown),
                  name: skill.name,
                  path:
                    skill.revision === undefined ? undefined : skillFilePath(skill.name, skillRoot),
                  source: id,
                },
              ]),
            ),
          };
        },
      };
    },
    id,
    install: syncDynamicSkillFiles,
    label: resolver.logicalPath,
  };
}

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
      if (files === undefined) continue;
      packages.set(skill.name, {
        description: skill.description,
        files,
        content: skill.markdown,
        name: skill.name,
      });
    }
  }
  if (desired.size === 0 && Object.keys(ctx.get(DynamicSkillSandboxKey) ?? {}).length === 0) {
    return;
  }

  access.prepare(async (open) => {
    const written = ctx.get(DynamicSkillSandboxKey) ?? {};
    const identity = sandboxIdentity(await access.captureState());
    const mark = (name: string) => `${identity}#${desired.get(name) ?? ""}`;
    const withdrawn = Object.keys(written).filter((name) => !kept.has(name));
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
      delete next[name];
      ctx.set(DynamicSkillSandboxKey, { ...next });
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
  if (skill.files.length > 1) durable.revision = skillPackageRevision(skill);
  return durable;
}

function sandboxIdentity(state: SandboxState): string | null {
  return state.session === null ? null : JSON.stringify(state.session);
}
