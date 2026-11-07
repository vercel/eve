import { SkillConflictError, SkillNotFoundError } from "../../extension/lib/errors.ts";
import type {
  SkillHead,
  SkillRepository,
  SkillVersionRecord,
} from "../../extension/lib/repository.ts";

/** A minimal repository keyed by scope key, for exercising the lifecycle. */
export function memoryRepository(): SkillRepository {
  const rows = new Map<string, { head: SkillHead; versions: SkillVersionRecord[] }>();
  const rowKey = (scopeKey: string, name: string) => JSON.stringify([scopeKey, name]);
  return {
    async listHeads(scope) {
      return [...rows.entries()]
        .filter(([key]) => JSON.parse(key)[0] === scope.key)
        .map(([, row]) => row.head);
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
      const key = rowKey(scope.key, request.name);
      const row = rows.get(key);
      const current = row?.head.latestVersion ?? null;
      if (request.expectedLatest !== current) throw new SkillConflictError("stale");
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
    async updateHead(scope, name, patch) {
      const row = rows.get(rowKey(scope.key, name));
      if (!row) throw new SkillNotFoundError(name);
      row.head = {
        ...row.head,
        liveVersion: patch.liveVersion ?? row.head.liveVersion,
        applicationMode: patch.applicationMode ?? row.head.applicationMode,
      };
      return row.head;
    },
    async remove(scope, names) {
      const removed = names.filter((name) => rows.delete(rowKey(scope.key, name)));
      return { removed, notFound: names.filter((name) => !removed.includes(name)) };
    },
  };
}
