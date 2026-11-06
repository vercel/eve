import { vercelBlob } from "eve/memory/file/vercel";

import extension from "../extension.ts";
import { documentRepository } from "./document-repository.ts";
import { SkillStorageNotConfiguredError } from "./errors.ts";
import { SkillLifecycle } from "./lifecycle.ts";
import type { SkillRepository } from "./repository.ts";
import { defaultScopeResolver } from "./scopes.ts";
import type { SkillAuth, SkillScope, StoredSkill } from "./types.ts";

let configured:
  | { readonly key: object; readonly lifecycle: SkillLifecycle<SkillScope> | null }
  | undefined;

function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim() || process.env.BLOB_STORE_ID?.trim());
}

function repositoryFor(config: typeof extension.config): SkillRepository<SkillScope> | null {
  if (config.repository) return config.repository;
  if (config.storage) return documentRepository({ backend: config.storage });
  if (blobConfigured()) return documentRepository({ backend: vercelBlob() });
  return null;
}

/** The lifecycle bound to this mount's config, or null when storage is missing. */
export function skillLifecycle(): SkillLifecycle<SkillScope> | null {
  const config = extension.config;
  if (configured?.key !== config) {
    const repository = repositoryFor(config);
    configured = {
      key: config,
      lifecycle: repository
        ? new SkillLifecycle({ repository, limits: config.limits, onChange: config.onChange })
        : null,
    };
  }
  return configured.lifecycle;
}

export function requireSkillLifecycle(): SkillLifecycle<SkillScope> {
  const lifecycle = skillLifecycle();
  if (!lifecycle) throw new SkillStorageNotConfiguredError();
  return lifecycle;
}

export function skillScopes(auth: SkillAuth | null | undefined): readonly SkillScope[] {
  return (extension.config.scopes ?? defaultScopeResolver)(auth);
}

export interface ScopeSkills {
  readonly scope: SkillScope;
  readonly skills: readonly StoredSkill[];
}

export interface TurnSkillsRequest {
  readonly auth: SkillAuth | null | undefined;
  readonly sessionId: string;
  readonly turnId?: string;
}

const MAX_CACHED_TURNS = 32;
const turnCache = new Map<string, Promise<ScopeSkills[]>>();

async function readTurnSkills(
  lifecycle: SkillLifecycle<SkillScope>,
  scopes: readonly SkillScope[],
): Promise<ScopeSkills[]> {
  const skills = await Promise.all(scopes.map((scope) => lifecycle.listLive(scope)));
  return scopes.map((scope, index) => ({ scope, skills: skills[index] ?? [] }));
}

/**
 * The live skills for this turn, by scope in precedence order. The skill and
 * instruction resolvers both run before every model call; this shares one
 * read per turn and scope set between them. A storage failure rejects instead
 * of resolving to no skills, and the rejection is evicted so a retry recovers.
 */
export function loadTurnSkills(request: TurnSkillsRequest): Promise<ScopeSkills[]> {
  const lifecycle = skillLifecycle();
  if (!lifecycle) return Promise.resolve([]);
  const scopes = skillScopes(request.auth);
  if (scopes.length === 0) return Promise.resolve([]);
  if (!request.turnId) return readTurnSkills(lifecycle, scopes);

  const key = JSON.stringify([
    request.sessionId,
    request.turnId,
    scopes.map(({ scope, ownerKey }) => [scope, ownerKey]),
  ]);
  const cached = turnCache.get(key);
  if (cached) return cached;
  const pending = readTurnSkills(lifecycle, scopes);
  turnCache.set(key, pending);
  pending.catch(() => {
    if (turnCache.get(key) === pending) turnCache.delete(key);
  });
  while (turnCache.size > MAX_CACHED_TURNS) {
    const oldest = turnCache.keys().next().value;
    if (oldest === undefined) break;
    turnCache.delete(oldest);
  }
  return pending;
}
