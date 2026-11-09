import { SkillConflictError, SkillNotFoundError } from "../../extension/lib/errors.ts";
import type {
  SkillHead,
  SkillRepository,
  SkillVersionRecord,
} from "../../extension/lib/repository.ts";

/** A minimal repository keyed by scope key, for exercising the lifecycle. */
export function memoryRepository(
  hooks: { beforeWrite?: () => Promise<void> } = {},
): SkillRepository {
  const rows = new Map<string, { head: SkillHead; versions: SkillVersionRecord[] }>();
  const revisions = new Map<string, number>();
  const rowKey = (scopeKey: string, name: string) => JSON.stringify([scopeKey, name]);
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
  return {
    async listHeads(scope) {
      return {
        heads: [...rows.entries()]
          .filter(([key]) => JSON.parse(key)[0] === scope.key)
          .map(([, row]) => row.head),
        revision: revisionOf(scope.key),
      };
    },
    async getHead(scope, name) {
      return rows.get(rowKey(scope.key, name))?.head ?? null;
    },
    async listVersions(scope, name) {
      return [...(rows.get(rowKey(scope.key, name))?.versions ?? [])];
    },
    async getVersions(scope, refs) {
      return refs.map(
        ({ name, version }) =>
          rows.get(rowKey(scope.key, name))?.versions.find((entry) => entry.version === version) ??
          null,
      );
    },
    async appendVersion(scope, request) {
      await hooks.beforeWrite?.();
      const key = rowKey(scope.key, request.name);
      const row = rows.get(key);
      const current = row?.head.latestVersion ?? null;
      if (request.expectedLatest !== current) throw new SkillConflictError("stale");
      commit(scope.key, request.expectedRevision);
      const version: SkillVersionRecord = {
        ...request.version,
        version: (current ?? 0) + 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      const head: SkillHead = {
        name: request.name,
        liveVersion: request.activate ? version.version : (row?.head.liveVersion ?? null),
        latestVersion: version.version,
        applicationMode: request.activate
          ? version.applicationMode
          : (row?.head.applicationMode ?? version.applicationMode),
        createdAt: row?.head.createdAt ?? version.createdAt,
        updatedAt: version.createdAt,
      };
      rows.set(key, { head, versions: [...(row?.versions ?? []), version] });
      return { head, version, replayed: false };
    },
    async updateHead(scope, { name, liveVersion, applicationMode, expectedRevision }) {
      await hooks.beforeWrite?.();
      const row = rows.get(rowKey(scope.key, name));
      if (!row) throw new SkillNotFoundError(name);
      commit(scope.key, expectedRevision);
      row.head = {
        ...row.head,
        liveVersion: liveVersion ?? row.head.liveVersion,
        applicationMode: applicationMode ?? row.head.applicationMode,
      };
      return row.head;
    },
    async remove(scope, names) {
      commit(scope.key, undefined);
      const removed = names.filter((name) => rows.delete(rowKey(scope.key, name)));
      return { removed, notFound: names.filter((name) => !removed.includes(name)) };
    },
  };
}
