import type { ModelMessage } from "ai";

import {
  ALLOWED_DYNAMIC_SKILL_EVENTS,
  isBrandedSkillEntry,
} from "#shared/dynamic-tool-definition.js";
import type { SkillPackageDefinition } from "#shared/skill-definition.js";
import { type MaterializableSkillPackage, normalizeSkillPackage } from "#shared/skill-package.js";
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
import {
  captureAuthoredSkillBaseline,
  recoverCapturedAuthoredSkillBaseline,
} from "#context/dynamic-skill-authored-baseline.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import {
  type DynamicSkillMaterializationMarkerRead,
  readDynamicSkillMaterializationMarker,
} from "#context/dynamic-skill-materialization-marker.js";
import {
  type DynamicSkillMaterializationResult,
  materializeDynamicSkillUpdates,
} from "#context/dynamic-skill-materialization.js";
import {
  dynamicSkillManifestsEqual,
  isFullRematerialization,
  retainCompiledResolverPackages,
  trustDynamicSkillMarker,
} from "#context/dynamic-skill-manifest.js";
import { logDynamicSkillMaterializationTelemetry } from "#context/dynamic-skill-telemetry.js";
import { resolveSandboxSkillRoot } from "#shared/skill-paths.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("dynamic-skills");

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

import { ContextKey } from "#context/key.js";

/**
 * Durable pending skill announcement text. Set by
 * {@link dispatchDynamicSkillEvent} whenever the dynamic skill manifest
 * changes. Read by the tool-loop to inject the announcement into model
 * context.
 */
export const PendingSkillAnnouncementKey = new ContextKey<string>("eve.pendingSkillAnnouncement");

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
  const totalStartedAt = performance.now();
  let announcementMs = 0;
  let markerMs = 0;
  let sandboxMs = 0;
  let sandbox: SandboxSession | null | undefined;
  let rawMarkerRead: DynamicSkillMaterializationMarkerRead | undefined;
  let trustedMarkerRead: DynamicSkillMaterializationMarkerRead | undefined;
  let trustedMarkerReadLoaded = false;
  let previousManifest = ctx.get(DynamicSkillManifestKey) ?? {};
  let activeManifest = previousManifest;
  const authoredPackageNames = new Set(
    (ctx.get(BundleKey)?.resolvedAgent.skills ?? []).map((skill) => skill.name),
  );

  const loadMaterializationState = async (): Promise<void> => {
    if (sandbox !== undefined) return;

    const sandboxStartedAt = performance.now();
    sandbox = await ctx.require(SandboxKey).get();
    sandboxMs = performance.now() - sandboxStartedAt;
    if (sandbox === null) return;

    const markerStartedAt = performance.now();
    rawMarkerRead = await readDynamicSkillMaterializationMarker({ sandbox });
    markerMs = performance.now() - markerStartedAt;
  };

  const loadTrustedMarker = async (): Promise<
    DynamicSkillMaterializationMarkerRead | undefined
  > => {
    await loadMaterializationState();
    if (!trustedMarkerReadLoaded) {
      trustedMarkerRead = await trustDynamicSkillMarker({
        manifest: previousManifest,
        markerRead: rawMarkerRead,
        sandbox,
      });
      trustedMarkerReadLoaded = true;
    }
    return trustedMarkerRead;
  };

  // A resolver removed by a rebuild no longer has code that can emit an empty
  // update. Retire its durable packages from the compiled resolver inventory
  // before they can be announced or loaded again.
  const reconciledManifest = retainCompiledResolverPackages(previousManifest, resolvers);
  if (!dynamicSkillManifestsEqual(previousManifest, reconciledManifest)) {
    const markerRead = await loadTrustedMarker();
    const nextManifest = isFullRematerialization(markerRead) ? {} : reconciledManifest;

    if (sandbox !== null && sandbox !== undefined && markerRead !== undefined) {
      await materializeDynamicSkillUpdates({
        markerMs,
        markerRead,
        nextManifest,
        previousManifest,
        sandbox,
        updates: [],
      });
      const markerStartedAt = performance.now();
      rawMarkerRead = await readDynamicSkillMaterializationMarker({ sandbox });
      markerMs += performance.now() - markerStartedAt;
    }

    previousManifest = nextManifest;
    activeManifest = nextManifest;
    trustedMarkerRead = undefined;
    trustedMarkerReadLoaded = false;
    ctx.set(DynamicSkillManifestKey, nextManifest);
    const announcementStartedAt = performance.now();
    ctx.setVirtualContext(
      PendingSkillAnnouncementKey,
      await formatDynamicSkillAnnouncement({ ctx, manifest: nextManifest }),
    );
    announcementMs += performance.now() - announcementStartedAt;
  }

  // Build phase: rebuild announcement from durable manifest when the
  // virtual key is empty (step boundary crossed). Re-announce only when the
  // sandbox marker still proves the durable packages are materialized.
  if (
    ctx.get(PendingSkillAnnouncementKey) === undefined &&
    Object.keys(previousManifest).length > 0
  ) {
    const markerRead = await loadTrustedMarker();
    if (
      sandbox !== null &&
      isFullRematerialization(markerRead) &&
      markerRead?.status !== "legacy"
    ) {
      activeManifest = {};
      ctx.set(DynamicSkillManifestKey, activeManifest);
      ctx.setVirtualContext(PendingSkillAnnouncementKey, "");
    } else {
      if (
        sandbox !== null &&
        sandbox !== undefined &&
        markerRead !== undefined &&
        markerRead.marker !== null &&
        markerRead.status === "missing"
      ) {
        await materializeDynamicSkillUpdates({
          markerMs,
          markerRead,
          nextManifest: previousManifest,
          previousManifest,
          sandbox,
          updates: [],
        });
      }
      const announcementStartedAt = performance.now();
      ctx.setVirtualContext(
        PendingSkillAnnouncementKey,
        await formatDynamicSkillAnnouncement({ ctx, manifest: previousManifest }),
      );
      announcementMs += performance.now() - announcementStartedAt;
    }
  }

  if (!ALLOWED_DYNAMIC_SKILL_EVENTS.has(event.type)) return;

  const matching = resolvers.filter((r) => r.eventNames.includes(event.type));
  if (matching.length === 0) return;

  const resolveCtx = buildResolveContext(ctx, messages);
  const updates: DynamicSkillUpdate[] = [];

  const resolverStartedAt = performance.now();
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
  const resolverMs = performance.now() - resolverStartedAt;

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

  const markerRead = await loadTrustedMarker();

  // Without a trustworthy marker, package bodies from resolvers that did not
  // run for this event cannot be proven present. Fail closed by retaining only
  // the packages resolved now, then remove every previously announced package
  // before writing the current set.
  const newManifest = isFullRematerialization(markerRead) ? {} : { ...activeManifest };
  const previousSkillsByName = new Map(
    Object.values(previousManifest)
      .flat()
      .map((skill) => [skill.name, skill]),
  );
  for (const { resolver, skills } of updates) {
    if (skills.length === 0) {
      delete newManifest[resolver.slug];
    } else {
      const metadata: DurableDynamicSkillMetadata[] = [];
      for (const skill of skills) {
        const previousSkill = previousSkillsByName.get(skill.name);
        let authoredBaseline = previousSkill?.authoredBaseline;
        let authoredBaselineSandboxId = previousSkill?.authoredBaselineSandboxId;
        if (
          authoredPackageNames.has(skill.name) &&
          sandbox !== null &&
          sandbox !== undefined &&
          (authoredBaseline === undefined || authoredBaselineSandboxId !== sandbox.id)
        ) {
          authoredBaseline =
            (await recoverCapturedAuthoredSkillBaseline({ name: skill.name, sandbox })) ??
            (await captureAuthoredSkillBaseline({ name: skill.name, sandbox }));
          authoredBaselineSandboxId = sandbox.id;
        }
        metadata.push({
          authoredBaseline,
          authoredBaselineSandboxId,
          contentDigest: skill.contentDigest,
          description: skill.description,
          name: skill.name,
          relativePaths: skill.files.map((file) => file.relativePath),
        });
      }
      newManifest[resolver.slug] = metadata;
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

  let materialization: DynamicSkillMaterializationResult | undefined;
  if (sandbox !== null && sandbox !== undefined && markerRead !== undefined) {
    // Record trusted dynamic ownership before the first write. If a first
    // materialization fails partway through, the next dispatch can clean only
    // that owned package without treating authored packages as disposable.
    ctx.set(DynamicSkillManifestKey, newManifest);
    materialization = await materializeDynamicSkillUpdates({
      markerMs,
      markerRead,
      nextManifest: newManifest,
      previousManifest,
      sandbox,
      updates: updates.map(({ resolver, skills }) => ({
        resolverSlug: resolver.slug,
        skills,
      })),
    });
  }

  ctx.set(DynamicSkillManifestKey, newManifest);
  if (!dynamicSkillManifestsEqual(activeManifest, newManifest)) {
    const announcementStartedAt = performance.now();
    ctx.setVirtualContext(
      PendingSkillAnnouncementKey,
      await formatDynamicSkillAnnouncement({ ctx, manifest: newManifest }),
    );
    announcementMs += performance.now() - announcementStartedAt;
  }

  logDynamicSkillMaterializationTelemetry({
    announcementMs,
    eventType: event.type,
    materialization,
    packages: updates.flatMap((update) => update.skills),
    resolverCount: matching.length,
    resolverMs,
    sandboxMs,
    totalMs: performance.now() - totalStartedAt,
  });
}
