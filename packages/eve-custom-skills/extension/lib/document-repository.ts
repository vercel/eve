import { randomUUID } from "node:crypto";

import { MemoryDocumentConflictError, type MemoryDocumentBackend } from "eve/memory/file";
import { z } from "zod";

import { SkillConflictError, SkillLifecycleError, SkillNotFoundError } from "./errors.ts";
import type {
  AppendVersionRequest,
  AppendVersionResult,
  RemoveSkillsResult,
  SkillHead,
  SkillHeadPatch,
  SkillRepository,
  SkillVersionRecord,
} from "./repository.ts";
import { SKILL_APPLICATION_MODES, type SkillScope } from "./types.ts";

const SCHEMA_VERSION = 1;
const MAX_CONFLICT_RETRIES = 8;

const versionEntrySchema = z.object({
  version: z.number().int().positive(),
  key: z.string(),
  idempotencyKey: z.string().optional(),
});

const skillEntrySchema = z.object({
  name: z.string(),
  liveVersion: z.number().int().positive().nullable(),
  applicationMode: z.enum(SKILL_APPLICATION_MODES),
  createdAt: z.string(),
  updatedAt: z.string(),
  versions: z.array(versionEntrySchema).min(1),
});

const catalogSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  skills: z.record(z.string(), skillEntrySchema),
});

const versionDocumentSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  name: z.string(),
  description: z.string(),
  markdown: z.string(),
  ownerLabel: z.string(),
  checksum: z.string(),
  validation: z.object({
    valid: z.boolean(),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  createdAt: z.string(),
});

type SkillEntry = z.infer<typeof skillEntrySchema>;
type Catalog = z.infer<typeof catalogSchema>;
type VersionDocument = z.infer<typeof versionDocumentSchema>;

export interface DocumentRepositoryOptions {
  /** Any versioned document store, such as `vercelBlob()` or `inMemory()` from `eve/memory/file`. */
  readonly backend: MemoryDocumentBackend;
  /** Key prefix for every document. Defaults to `custom-skills`. */
  readonly prefix?: string;
  readonly now?: () => Date;
}

/**
 * Stores each scope's skills in a memory document backend: one catalog
 * document per scope holds every skill's head and version index, and each
 * version's content is its own document under a unique key.
 *
 * Catalog writes are compare-and-swap, so version numbers, live versions, and
 * modes never race. A version's content is written before the catalog entry
 * that numbers it; deleted skills overwrite their version documents with an
 * empty tombstone because the backend has no delete.
 */
export function documentRepository(
  options: DocumentRepositoryOptions,
): SkillRepository<SkillScope> {
  return new DocumentSkillRepository(options);
}

function toHead(id: string, entry: SkillEntry, ownerKey: string): SkillHead {
  return {
    id,
    name: entry.name,
    ownerKey,
    liveVersion: entry.liveVersion,
    latestVersion: entry.versions.at(-1)?.version ?? 0,
    applicationMode: entry.applicationMode,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function toRecord(version: number, document: VersionDocument): SkillVersionRecord {
  return {
    version,
    name: document.name,
    description: document.description,
    markdown: document.markdown,
    ownerLabel: document.ownerLabel,
    checksum: document.checksum,
    validation: document.validation,
    createdAt: document.createdAt,
  };
}

function conflictMessage(id: string, current: number | null, expected: number | null): string {
  if (current === null) return `Skill "${id}" no longer exists. Read it again before saving.`;
  if (expected === null) return `A skill named "${id}" already exists.`;
  return `Skill "${id}" changed: its latest version is ${current}, not ${expected}. Read it again before saving.`;
}

class DocumentSkillRepository implements SkillRepository<SkillScope> {
  readonly #backend: MemoryDocumentBackend;
  readonly #prefix: string;
  readonly #now: () => Date;
  readonly #signal = new AbortController().signal;

  constructor(options: DocumentRepositoryOptions) {
    this.#backend = options.backend;
    this.#prefix = options.prefix ?? "custom-skills";
    this.#now = options.now ?? (() => new Date());
  }

  #catalogKey(scope: SkillScope): string {
    return `${this.#prefix}/${scope.ownerKey}`;
  }

  async #readCatalog(scope: SkillScope): Promise<{ catalog: Catalog; version: string | null }> {
    const document = await this.#backend.read({
      key: this.#catalogKey(scope),
      signal: this.#signal,
    });
    if (!document) return { catalog: { schemaVersion: SCHEMA_VERSION, skills: {} }, version: null };
    return {
      catalog: catalogSchema.parse(JSON.parse(document.content)),
      version: document.version,
    };
  }

  /** Applies `change` to the latest catalog, retrying when another write lands first. */
  async #updateCatalog<T>(scope: SkillScope, change: (catalog: Catalog) => T): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const { catalog, version } = await this.#readCatalog(scope);
      const before = JSON.stringify(catalog);
      const result = change(catalog);
      if (JSON.stringify(catalog) === before) return result;
      try {
        await this.#backend.write({
          key: this.#catalogKey(scope),
          content: JSON.stringify(catalog),
          expectedVersion: version,
          signal: this.#signal,
        });
        return result;
      } catch (error) {
        if (!MemoryDocumentConflictError.is(error) || attempt >= MAX_CONFLICT_RETRIES) throw error;
      }
    }
  }

  async #readVersion(key: string): Promise<VersionDocument | null> {
    const document = await this.#backend.read({ key, signal: this.#signal });
    if (!document || document.content === "") return null;
    return versionDocumentSchema.parse(JSON.parse(document.content));
  }

  async #tombstone(key: string): Promise<void> {
    try {
      const document = await this.#backend.read({ key, signal: this.#signal });
      if (!document || document.content === "") return;
      await this.#backend.write({
        key,
        content: "",
        expectedVersion: document.version,
        signal: this.#signal,
      });
    } catch (error) {
      console.warn("[custom-skills] could not clear a removed skill version", error);
    }
  }

  async #replay(
    scope: SkillScope,
    id: string,
    entry: SkillEntry,
    idempotencyKey: string | undefined,
  ): Promise<AppendVersionResult | null> {
    if (idempotencyKey === undefined) return null;
    const saved = entry.versions.find((version) => version.idempotencyKey === idempotencyKey);
    if (!saved) return null;
    const document = await this.#readVersion(saved.key);
    if (!document) return null;
    return {
      head: toHead(id, entry, scope.ownerKey),
      version: toRecord(saved.version, document),
      replayed: true,
    };
  }

  async listHeads(scope: SkillScope): Promise<SkillHead[]> {
    const { catalog } = await this.#readCatalog(scope);
    return Object.entries(catalog.skills).map(([id, entry]) => toHead(id, entry, scope.ownerKey));
  }

  async getHead(scope: SkillScope, id: string): Promise<SkillHead | null> {
    const { catalog } = await this.#readCatalog(scope);
    const entry = catalog.skills[id];
    return entry ? toHead(id, entry, scope.ownerKey) : null;
  }

  async listVersions(scope: SkillScope, id: string): Promise<SkillVersionRecord[]> {
    const { catalog } = await this.#readCatalog(scope);
    const entry = catalog.skills[id];
    if (!entry) return [];
    const documents = await Promise.all(
      entry.versions.map(async ({ version, key }) => {
        const document = await this.#readVersion(key);
        return document ? toRecord(version, document) : null;
      }),
    );
    return documents.filter((record): record is SkillVersionRecord => record !== null);
  }

  async getVersion(
    scope: SkillScope,
    id: string,
    version: number,
  ): Promise<SkillVersionRecord | null> {
    const { catalog } = await this.#readCatalog(scope);
    const saved = catalog.skills[id]?.versions.find((entry) => entry.version === version);
    if (!saved) return null;
    const document = await this.#readVersion(saved.key);
    return document ? toRecord(version, document) : null;
  }

  async appendVersion(
    scope: SkillScope,
    request: AppendVersionRequest,
  ): Promise<AppendVersionResult> {
    const id = request.id ?? randomUUID();
    const { catalog } = await this.#readCatalog(scope);
    const existing = catalog.skills[id];
    if (existing) {
      const replay = await this.#replay(scope, id, existing, request.idempotencyKey);
      if (replay) return replay;
    }
    const current = existing ? (existing.versions.at(-1)?.version ?? 0) : null;
    if (request.expectedLatest !== current) {
      throw new SkillConflictError(conflictMessage(id, current, request.expectedLatest));
    }

    const createdAt = this.#now().toISOString();
    const document: VersionDocument = {
      schemaVersion: SCHEMA_VERSION,
      ...request.version,
      ownerLabel: scope.ownerLabel,
      createdAt,
    };
    const key = `${this.#catalogKey(scope)}/${id}/${randomUUID()}`;
    await this.#backend.write({
      key,
      content: JSON.stringify(document),
      expectedVersion: null,
      signal: this.#signal,
    });

    try {
      const outcome = await this.#updateCatalog(scope, (latest) => {
        const entry = latest.skills[id];
        const replayed = entry?.versions.find(
          (version) =>
            request.idempotencyKey !== undefined &&
            version.idempotencyKey === request.idempotencyKey,
        );
        if (entry && replayed) return { entry, version: replayed.version, replayed: true };
        const latestVersion = entry ? (entry.versions.at(-1)?.version ?? 0) : null;
        if (request.expectedLatest !== latestVersion) {
          throw new SkillConflictError(conflictMessage(id, latestVersion, request.expectedLatest));
        }
        const version = (latestVersion ?? 0) + 1;
        const saved: z.infer<typeof versionEntrySchema> = { version, key };
        if (request.idempotencyKey !== undefined) saved.idempotencyKey = request.idempotencyKey;
        const next: SkillEntry = {
          name: request.version.name,
          liveVersion: request.head.activate ? version : (entry?.liveVersion ?? null),
          applicationMode: request.head.applicationMode,
          createdAt: entry?.createdAt ?? createdAt,
          updatedAt: createdAt,
          versions: [...(entry?.versions ?? []), saved],
        };
        latest.skills[id] = next;
        return { entry: next, version, replayed: false };
      });
      if (outcome.replayed) {
        await this.#tombstone(key);
        const replay = await this.#replay(scope, id, outcome.entry, request.idempotencyKey);
        if (replay) return replay;
        throw new SkillLifecycleError(`Skill "${id}" lost a replayed version.`);
      }
      return {
        head: toHead(id, outcome.entry, scope.ownerKey),
        version: toRecord(outcome.version, document),
        replayed: false,
      };
    } catch (error) {
      await this.#tombstone(key);
      throw error;
    }
  }

  async updateHead(scope: SkillScope, id: string, patch: SkillHeadPatch): Promise<SkillHead> {
    const entry = await this.#updateCatalog(scope, (catalog) => {
      const current = catalog.skills[id];
      if (!current) throw new SkillNotFoundError(id);
      const next: SkillEntry = { ...current, updatedAt: this.#now().toISOString() };
      if (patch.liveVersion !== undefined) next.liveVersion = patch.liveVersion;
      if (patch.applicationMode !== undefined) next.applicationMode = patch.applicationMode;
      catalog.skills[id] = next;
      return next;
    });
    return toHead(id, entry, scope.ownerKey);
  }

  async remove(scope: SkillScope, ids: readonly string[]): Promise<RemoveSkillsResult> {
    const removed = await this.#updateCatalog(scope, (catalog) => {
      const entries: Array<{ id: string; keys: string[] }> = [];
      for (const id of new Set(ids)) {
        const entry = catalog.skills[id];
        if (!entry) continue;
        entries.push({ id, keys: entry.versions.map(({ key }) => key) });
        delete catalog.skills[id];
      }
      return entries;
    });
    await Promise.all(removed.flatMap(({ keys }) => keys.map((key) => this.#tombstone(key))));
    const removedIds = new Set(removed.map(({ id }) => id));
    return {
      removed: removed.map(({ id }) => ({ id, ownerKey: scope.ownerKey })),
      notFound: [...new Set(ids)].filter((id) => !removedIds.has(id)),
    };
  }
}
