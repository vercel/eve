import { vercelBlob } from "eve/memory/file/vercel";

import extension from "../extension.ts";
import { documentRepository } from "./document-repository.ts";
import { SkillStorageNotConfiguredError } from "./errors.ts";
import { SkillLifecycle } from "./lifecycle.ts";
import type { SkillRepository } from "./repository.ts";
import { defaultScopes } from "./scopes.ts";
import type { SkillScope, SkillScopeContext, StoredSkill } from "./types.ts";

type Config = typeof extension.config;

const LOAD_PREFIX = /^[a-z0-9][a-z0-9-]*$/;

const lifecycles = new WeakMap<Config, SkillLifecycle | null>();

function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim() || process.env.BLOB_STORE_ID?.trim());
}

function repositoryFor(config: Config): SkillRepository | null {
  if (config.repository) return config.repository;
  const backend = config.storage ?? (blobConfigured() ? vercelBlob() : null);
  return backend ? documentRepository({ backend, namespace: config.namespace }) : null;
}

/** This mount's config. Each mount binds its own, even when two mount this extension. */
export function skillConfig(): Config {
  return extension.config;
}

/** The lifecycle bound to this mount's config, or null when storage is missing. */
export function skillLifecycle(): SkillLifecycle | null {
  const config = skillConfig();
  if (!lifecycles.has(config)) {
    const repository = repositoryFor(config);
    lifecycles.set(
      config,
      repository
        ? new SkillLifecycle({ repository, limits: config.limits, validator: config.validate })
        : null,
    );
  }
  return lifecycles.get(config) ?? null;
}

export function requireSkillLifecycle(): SkillLifecycle {
  const lifecycle = skillLifecycle();
  if (!lifecycle) throw new SkillStorageNotConfiguredError();
  return lifecycle;
}

export async function skillScopes(ctx: SkillScopeContext): Promise<readonly SkillScope[]> {
  const scopes = await (skillConfig().scopes ?? defaultScopes)({
    session: { id: ctx.session.id, auth: ctx.session.auth },
    ...(ctx.conversation !== undefined && { conversation: ctx.conversation }),
  });
  const names = new Set<string>();
  const prefixes = new Set<string>();
  for (const scope of scopes) {
    const prefix = scope.loadPrefix ?? "";
    if (prefix !== "" && !LOAD_PREFIX.test(prefix)) {
      throw new Error(
        `[custom-skills] scope "${scope.name}" has load prefix "${prefix}"; use lowercase letters, digits, and hyphens.`,
      );
    }
    if (names.has(scope.name)) {
      throw new Error(`[custom-skills] two scopes share the name "${scope.name}".`);
    }
    if (prefixes.has(prefix)) {
      throw new Error(
        `[custom-skills] two scopes share the load prefix "${prefix}", so their skills could collide.`,
      );
    }
    names.add(scope.name);
    prefixes.add(prefix);
  }
  return scopes;
}

export interface ScopeSkills {
  readonly scope: SkillScope;
  readonly skills: readonly StoredSkill[];
}

const MAX_CACHED_TURNS = 32;
const turnCaches = new WeakMap<SkillLifecycle, Map<string, Promise<ScopeSkills[]>>>();

async function readTurnSkills(
  lifecycle: SkillLifecycle,
  scopes: readonly SkillScope[],
): Promise<ScopeSkills[]> {
  const skills = await Promise.all(scopes.map((scope) => lifecycle.listLive(scope)));
  return scopes.map((scope, index) => ({ scope, skills: skills[index] ?? [] }));
}

/**
 * The live skills for this turn, by scope in precedence order. The skill and
 * instruction resolvers both run before every model call; this shares one
 * read per turn, mount, and scope set between them. A storage failure rejects
 * instead of resolving to no skills, and the rejection is evicted so a retry
 * recovers.
 */
export async function loadTurnSkills(
  ctx: SkillScopeContext & { readonly turnId?: string },
): Promise<ScopeSkills[]> {
  const lifecycle = skillLifecycle();
  if (!lifecycle) return [];
  const scopes = await skillScopes(ctx);
  if (scopes.length === 0) return [];
  if (!ctx.turnId) return readTurnSkills(lifecycle, scopes);

  let cache = turnCaches.get(lifecycle);
  if (!cache) turnCaches.set(lifecycle, (cache = new Map()));
  const key = JSON.stringify([ctx.session.id, ctx.turnId, scopes.map(({ key }) => key)]);
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = readTurnSkills(lifecycle, scopes);
  cache.set(key, pending);
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  while (cache.size > MAX_CACHED_TURNS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return pending;
}
