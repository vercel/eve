import { SkillConflictError, SkillNotFoundError } from "../../extension/lib/errors.ts";
import type {
  SkillHead,
  SkillRepository,
  SkillVersionRecord,
} from "../../extension/lib/repository.ts";

/**
 * A minimal repository keyed by scope key and skill ID, for exercising the
 * lifecycle. It assigns its own IDs, as a database might.
 */
export function memoryRepository(
  hooks: { beforeWrite?: () => Promise<void> } = {},
): SkillRepository {
  const rows = new Map<
    string,
    { scope: string; head: SkillHead; versions: SkillVersionRecord[] }
  >();
  const revisions = new Map<string, number>();
  let nextId = 1;
  const revisionOf = (scopeKey: string) => {
    const revision = revisions.get(scopeKey);
    return revision === undefined ? null : String(revision);
  };
  /** Checks the scope revision and bumps it, as one atomic step. */
  const commit = (scopeKey: string, expected: string | null | undefined) => {
    if (expected !== undefined && revisionOf(scopeKey) !== expected) {
      throw new SkillConflictError("scope changed");
    }
    revisions.set(scopeKey, (revisions.get(scopeKey) ?? 0) + 1);
  };
  const inScope = (scopeKey: string) => [...rows.values()].filter((row) => row.scope === scopeKey);
  const row = (scopeKey: string, id: string) => {
    const found = rows.get(id);
    return found?.scope === scopeKey ? found : undefined;
  };
  return {
    async listHeads(scope) {
      return { heads: inScope(scope.key).map(({ head }) => head), revision: revisionOf(scope.key) };
    },
    async getHead(scope, name) {
      return inScope(scope.key).find(({ head }) => head.name === name)?.head ?? null;
    },
    async listVersions(scope, id) {
      return [...(row(scope.key, id)?.versions ?? [])];
    },
    async getVersions(scope, refs) {
      return refs.map(
        ({ id, version }) =>
          row(scope.key, id)?.versions.find((entry) => entry.version === version) ?? null,
      );
    },
    async appendVersion(scope, request) {
      await hooks.beforeWrite?.();
      const existing = row(scope.key, request.id);
      const current = existing?.head.latestVersion ?? null;
      if (request.expectedLatest !== current) throw new SkillConflictError("stale");
      if (!existing && inScope(scope.key).some(({ head }) => head.name === request.name)) {
        throw new SkillConflictError("name taken");
      }
      commit(scope.key, request.expectedRevision);
      const id = existing?.head.id ?? `skill-${nextId++}`;
      const version: SkillVersionRecord = {
        ...request.version,
        version: (current ?? 0) + 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      const head: SkillHead = {
        id,
        name: request.name,
        liveVersion: request.activate ? version.version : (existing?.head.liveVersion ?? null),
        latestVersion: version.version,
        applicationMode: request.activate
          ? version.applicationMode
          : (existing?.head.applicationMode ?? version.applicationMode),
        createdAt: existing?.head.createdAt ?? version.createdAt,
        updatedAt: version.createdAt,
      };
      rows.set(id, { scope: scope.key, head, versions: [...(existing?.versions ?? []), version] });
      return { head, version, replayed: false };
    },
    async updateHead(scope, { id, liveVersion, applicationMode, expectedRevision }) {
      await hooks.beforeWrite?.();
      const found = row(scope.key, id);
      if (!found) throw new SkillNotFoundError(id);
      commit(scope.key, expectedRevision);
      found.head = {
        ...found.head,
        liveVersion: liveVersion ?? found.head.liveVersion,
        applicationMode: applicationMode ?? found.head.applicationMode,
      };
      return found.head;
    },
    async remove(scope, ids) {
      commit(scope.key, undefined);
      const removed = ids.filter((id) => row(scope.key, id) && rows.delete(id));
      return { removed, notFound: ids.filter((id) => !removed.includes(id)) };
    },
  };
}
