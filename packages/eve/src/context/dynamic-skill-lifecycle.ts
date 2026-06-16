import type { ModelMessage } from "ai";

import {
  ALLOWED_DYNAMIC_SKILL_EVENTS,
  isBrandedSkillEntry,
} from "#shared/dynamic-tool-definition.js";
import type { SkillPackageDefinition } from "#shared/skill-definition.js";
import {
  type MaterializableSkillPackage,
  normalizeSkillPackage,
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
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";

const log = createLogger("dynamic-skills");

// ---------------------------------------------------------------------------
// Name qualification
// ---------------------------------------------------------------------------

function qualifyDynamicSkillNames(
  slug: string,
  isSingle: boolean,
  entries: Readonly<Record<string, SkillPackageDefinition>>,
): Array<{ name: string; entryKey: string; entry: SkillPackageDefinition }> {
  const keys = Object.keys(entries);
  const result: Array<{ name: string; entryKey: string; entry: SkillPackageDefinition }> = [];

  if (keys.length === 0) return result;

  if (isSingle || keys.length === 1) {
    result.push({ name: slug, entryKey: keys[0]!, entry: entries[keys[0]!]! });
    return result;
  }

  for (const key of keys) {
    result.push({ name: `${slug}__${key}`, entryKey: key, entry: entries[key]! });
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

function formatDynamicSkillAnnouncement(
  manifest: Readonly<Record<string, readonly DurableDynamicSkillMetadata[]>>,
): string {
  return formatAvailableSkillsSection(Object.values(manifest).flat()) ?? "";
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
      ctx.setVirtualContext(PendingSkillAnnouncementKey, formatDynamicSkillAnnouncement(manifest));
    }
  }

  if (!ALLOWED_DYNAMIC_SKILL_EVENTS.has(event.type)) return;

  const matching = resolvers.filter((r) => r.eventNames.includes(event.type));
  if (matching.length === 0) return;

  const resolveCtx = buildResolveContext(ctx, messages);
  const authoredSkillNames = new Set(
    ctx.require(BundleKey).resolvedAgent.skills.map((s) => s.name),
  );
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

      const named = qualifyDynamicSkillNames(resolver.slug, isSingle, entries);
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

  const dynamicSkillOwners = new Map<string, string>();
  for (const [resolverSlug, skills] of Object.entries(newManifest)) {
    for (const { name } of skills) {
      if (authoredSkillNames.has(name)) {
        throw new Error(
          `Dynamic skill "${name}" from resolver "${resolverSlug}" conflicts with an authored skill.`,
        );
      }
      const previousOwner = dynamicSkillOwners.get(name);
      if (previousOwner !== undefined) {
        throw new Error(
          `Dynamic skill "${name}" from resolver "${resolverSlug}" conflicts with dynamic resolver "${previousOwner}".`,
        );
      }
      dynamicSkillOwners.set(name, resolverSlug);
    }
  }

  const sandbox = await ctx.require(SandboxKey).get();

  if (sandbox !== null) {
    for (const { skills } of updates) {
      for (const skill of skills) {
        await writeSkillPackageToSandbox({ sandbox, skill });
      }
    }
  }

  ctx.set(DynamicSkillManifestKey, newManifest);
  ctx.setVirtualContext(PendingSkillAnnouncementKey, formatDynamicSkillAnnouncement(newManifest));
}
