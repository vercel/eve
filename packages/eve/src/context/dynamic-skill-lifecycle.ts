import type { ModelMessage } from "ai";

import {
  ALLOWED_DYNAMIC_SKILL_EVENTS,
  isBrandedSkillEntry,
} from "#shared/dynamic-tool-definition.js";
import type { SkillPackageDefinition } from "#shared/skill-definition.js";
import {
  type MaterializableSkillPackage,
  normalizeSkillPackage,
  removeSkillPackageFromSandbox,
  writeSkillPackageToSandbox,
} from "#shared/skill-package.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { ResolvedDynamicSkillResolver } from "#runtime/types.js";
import { formatAvailableSkillsSection } from "#execution/skills/instructions.js";
import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ContextContainer } from "#context/container.js";
import {
  type DurableDynamicSkillMetadata,
  DynamicSkillManifestKey,
  SandboxKey,
} from "#context/keys.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import { resolveSandboxSkillRoot } from "#shared/skill-paths.js";

const log = createLogger("dynamic-skills");

// ---------------------------------------------------------------------------
// Name qualification
// ---------------------------------------------------------------------------

function qualifyDynamicSkillNames(
  resolver: { readonly slug: string; readonly extensionNamespace?: string },
  isSingle: boolean,
  entries: Readonly<Record<string, SkillPackageDefinition>>,
): Array<{ name: string; entryKey: string; entry: SkillPackageDefinition }> {
  const keys = Object.keys(entries);
  const result: Array<{ name: string; entryKey: string; entry: SkillPackageDefinition }> = [];

  if (keys.length === 0) return result;

  // A single returned defineSkill is named after the file slug (already
  // namespaced for an extension). A map names each entry by its bare key.
  if (isSingle) {
    result.push({ name: resolver.slug, entryKey: keys[0]!, entry: entries[keys[0]!]! });
    return result;
  }

  // Map entries from an extension resolver are prefixed with the mount
  // namespace so extension-produced skills are namespaced like the extension's
  // static skills; a non-extension resolver's keys stay bare.
  const prefix =
    resolver.extensionNamespace !== undefined ? `${resolver.extensionNamespace}__` : "";
  for (const key of keys) {
    result.push({ name: `${prefix}${key}`, entryKey: key, entry: entries[key]! });
  }
  return result;
}

interface DynamicSkillUpdate {
  readonly resolver: ResolvedDynamicSkillResolver;
  readonly skills: readonly MaterializableSkillPackage[];
}

interface DynamicSkillResolution {
  readonly resolver: ResolvedDynamicSkillResolver;
  readonly named: readonly { name: string; entry: SkillPackageDefinition }[];
}

async function formatDynamicSkillAnnouncement(input: {
  readonly ctx: ContextContainer;
  readonly manifest: Readonly<Record<string, readonly DurableDynamicSkillMetadata[]>>;
}): Promise<string> {
  const sandbox = await input.ctx.require(SandboxKey).get();
  const skillRoot = sandbox === null ? undefined : await resolveSandboxSkillRoot({ sandbox });
  return formatAvailableSkillsSection(Object.values(input.manifest).flat(), { skillRoot }) ?? "";
}

// ---------------------------------------------------------------------------
// Single entry detection
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Context key for pending announcements
// ---------------------------------------------------------------------------

import { ContextKey } from "#context/key.js";

/**
 * Durable pending skill announcement text. Set by
 * {@link dispatchDynamicSkillEvent} whenever the dynamic skill manifest
 * changes. Read by the tool-loop to inject the announcement into model
 * context.
 */
export const PendingSkillAnnouncementKey = new ContextKey<string>("eve.pendingSkillAnnouncement");

// ---------------------------------------------------------------------------
// Event dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatches a stream event to dynamic skill resolvers. On a matching
 * event: runs handlers, materializes resolved skills to the sandbox,
 * cleans up removed skills, and stores a pending announcement for the
 * tool-loop to inject.
 */
export async function dispatchDynamicSkillEvent(input: {
  readonly ctx: ContextContainer;
  readonly resolvers: readonly ResolvedDynamicSkillResolver[];
  readonly event: HandleMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
}): Promise<void> {
  const { ctx, resolvers, event, messages } = input;

  // Build phase: rebuild announcement from durable manifest when the
  // virtual key is empty (step boundary crossed). Sandbox files persist;
  // only the announcement needs rebuilding.
  if (ctx.get(PendingSkillAnnouncementKey) === undefined) {
    const manifest = ctx.get(DynamicSkillManifestKey);
    if (manifest !== undefined && Object.keys(manifest).length > 0) {
      ctx.setVirtualContext(
        PendingSkillAnnouncementKey,
        await formatDynamicSkillAnnouncement({ ctx, manifest }),
      );
    }
  }

  if (!ALLOWED_DYNAMIC_SKILL_EVENTS.has(event.type)) return;

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

  const newManifest = { ...manifest };
  for (const { resolver, skills } of updates) {
    if (skills.length === 0) {
      delete newManifest[resolver.slug];
    } else {
      newManifest[resolver.slug] = skills.map((skill) => ({
        description: skill.description,
        name: skill.name,
      }));
    }
  }

  // A dynamic skill whose name matches an authored skill overrides it: the
  // dynamic write overwrites the authored file at the same sandbox path, so
  // load_skill returns the dynamic body. Two dynamic resolvers emitting the
  // same name is a genuine ambiguity and still throws.
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

  const sandbox = await ctx.require(SandboxKey).get();

  if (sandbox !== null) {
    const finalDynamicSkillNames = new Set(
      Object.values(newManifest)
        .flat()
        .map((skill) => skill.name),
    );
    const removedSkillNames = new Set<string>();

    for (const { resolver } of updates) {
      for (const skill of manifest[resolver.slug] ?? []) {
        if (!finalDynamicSkillNames.has(skill.name)) {
          removedSkillNames.add(skill.name);
        }
      }
    }

    for (const name of removedSkillNames) {
      await removeSkillPackageFromSandbox({ name, sandbox });
    }

    for (const { skills } of updates) {
      for (const skill of skills) {
        await writeSkillPackageToSandbox({ sandbox, skill });
      }
    }
  }

  ctx.set(DynamicSkillManifestKey, newManifest);
  ctx.setVirtualContext(
    PendingSkillAnnouncementKey,
    await formatDynamicSkillAnnouncement({ ctx, manifest: newManifest }),
  );
}
