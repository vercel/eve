import { createHash, randomUUID } from "node:crypto";

import { MemoryDocumentConflictError, type MemoryDocumentBackend } from "eve/memory/file";
import { z } from "zod";

import { SkillConflictError, SkillLifecycleError, SkillNotFoundError } from "./errors.ts";
import type {
  AppendVersionRequest,
  AppendVersionResult,
  RemoveSkillsResult,
  SkillCatalog,
  SkillHead,
  SkillHeadUpdate,
  SkillRepository,
  SkillVersionRecord,
  SkillVersionRef,
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
  description: z.string(),
  markdown: z.string(),
  applicationMode: z.enum(SKILL_APPLICATION_MODES),
  checksum: z.string(),
  validation: z.object({
    valid: z.boolean(),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  savedBy: z.object({ principalId: z.string().nullable(), label: z.string() }),
  createdAt: z.string(),
});

type SkillEntry = z.infer<typeof skillEntrySchema>;
type Catalog = z.infer<typeof catalogSchema>;
type VersionDocument = z.infer<typeof versionDocumentSchema>;

export interface DocumentRepositoryOptions {
  /** Any versioned document store, such as `vercelBlob()` or `inMemory()` from `eve/memory/file`. */
  readonly backend: MemoryDocumentBackend;
  /**
   * Key prefix for every document. Give each agent that shares a store its
   * own namespace, or they share every user's skills. Defaults to `custom-skills`.
   */
  readonly namespace?: string;
  readonly now?: () => Date;
}

/**
 * Stores each scope's skills in a memory document backend: one catalog
 * document per scope holds every skill's head and version index, and each
 * version's content is its own document under a unique key.
 *
 * Catalog writes are compare-and-swap, so version numbers, live versions, and
 * modes never race. A version's content is written before the catalog entry
 * that numbers it. Removing a skill overwrites its version documents with an
 * empty tombstone, because the backend has no delete; a backend that keeps
 * object history still holds the old content.
 */
export function documentRepository(options: DocumentRepositoryOptions): SkillRepository {
  return new DocumentSkillRepository(options);
}

function toHead(name: string, entry: SkillEntry): SkillHead {
  return {
    name,
    liveVersion: entry.liveVersion,
    latestVersion: entry.versions.at(-1)?.version ?? 0,
    applicationMode: entry.applicationMode,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function toRecord(version: number, document: VersionDocument): SkillVersionRecord {
  const { schemaVersion: _schemaVersion, ...record } = document;
  return { version, ...record };
}

function conflictMessage(name: string, current: number | null, expected: number | null): string {
  if (current === null) return `Skill "${name}" no longer exists. Read it again before saving.`;
  if (expected === null) return `A skill named "${name}" already exists.`;
  return `Skill "${name}" changed: its latest version is ${current}, not ${expected}. Read it again before saving.`;
}

class DocumentSkillRepository implements SkillRepository {
  readonly #backend: MemoryDocumentBackend;
  readonly #namespace: string;
  readonly #now: () => Date;
  readonly #signal = new AbortController().signal;

  constructor(options: DocumentRepositoryOptions) {
    this.#backend = options.backend;
    this.#namespace = options.namespace ?? "custom-skills";
    this.#now = options.now ?? (() => new Date());
  }

  /** Hashing the scope key keeps any key path-safe and stops two keys from colliding. */
  #catalogKey(scope: SkillScope): string {
    return `${this.#namespace}/${createHash("sha256").update(scope.key).digest("hex")}`;
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

  /**
   * Applies `change` to the latest catalog, retrying when another write lands
   * first. With `expectedRevision`, any other write since that revision fails
   * the change instead, so the caller can check its limits again.
   */
  async #updateCatalog<T>(
    scope: SkillScope,
    change: (catalog: Catalog) => T,
    expectedRevision?: string | null,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const { catalog, version } = await this.#readCatalog(scope);
      if (expectedRevision !== undefined && version !== expectedRevision) {
        throw new SkillConflictError(
          "The skills in this scope changed while this change was checked. Try again.",
        );
      }
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
    name: string,
    entry: SkillEntry,
    idempotencyKey: string | undefined,
  ): Promise<AppendVersionResult | null> {
    if (idempotencyKey === undefined) return null;
    const saved = entry.versions.find((version) => version.idempotencyKey === idempotencyKey);
    if (!saved) return null;
    const document = await this.#readVersion(saved.key);
    if (!document) return null;
    return {
      head: toHead(name, entry),
      version: toRecord(saved.version, document),
      replayed: true,
    };
  }

  async listHeads(scope: SkillScope): Promise<SkillCatalog> {
    const { catalog, version } = await this.#readCatalog(scope);
    return {
      heads: Object.entries(catalog.skills).map(([name, entry]) => toHead(name, entry)),
      revision: version,
    };
  }

  async getHead(scope: SkillScope, name: string): Promise<SkillHead | null> {
    const { catalog } = await this.#readCatalog(scope);
    const entry = catalog.skills[name];
    return entry ? toHead(name, entry) : null;
  }

  async listVersions(scope: SkillScope, name: string): Promise<SkillVersionRecord[]> {
    const { catalog } = await this.#readCatalog(scope);
    const entry = catalog.skills[name];
    if (!entry) return [];
    const documents = await Promise.all(
      entry.versions.map(async ({ version, key }) => {
        const document = await this.#readVersion(key);
        return document ? toRecord(version, document) : null;
      }),
    );
    return documents.filter((record): record is SkillVersionRecord => record !== null);
  }

  async getVersions(
    scope: SkillScope,
    refs: readonly SkillVersionRef[],
  ): Promise<Array<SkillVersionRecord | null>> {
    if (refs.length === 0) return [];
    const { catalog } = await this.#readCatalog(scope);
    return Promise.all(
      refs.map(async ({ name, version }) => {
        const saved = catalog.skills[name]?.versions.find((entry) => entry.version === version);
        if (!saved) return null;
        const document = await this.#readVersion(saved.key);
        return document ? toRecord(version, document) : null;
      }),
    );
  }

  async appendVersion(
    scope: SkillScope,
    request: AppendVersionRequest,
  ): Promise<AppendVersionResult> {
    const { name } = request;
    const { catalog } = await this.#readCatalog(scope);
    const existing = catalog.skills[name];
    if (existing) {
      const replay = await this.#replay(name, existing, request.idempotencyKey);
      if (replay) return replay;
    }
    const current = existing ? (existing.versions.at(-1)?.version ?? 0) : null;
    if (request.expectedLatest !== current) {
      throw new SkillConflictError(conflictMessage(name, current, request.expectedLatest));
    }

    const createdAt = this.#now().toISOString();
    const document: VersionDocument = {
      schemaVersion: SCHEMA_VERSION,
      ...request.version,
      validation: {
        ...request.version.validation,
        errors: [...request.version.validation.errors],
        warnings: [...request.version.validation.warnings],
      },
      createdAt,
    };
    const key = `${this.#catalogKey(scope)}/${randomUUID()}`;
    await this.#backend.write({
      key,
      content: JSON.stringify(document),
      expectedVersion: null,
      signal: this.#signal,
    });

    try {
      const outcome = await this.#updateCatalog(
        scope,
        (latest) => {
          const entry = latest.skills[name];
          const replayed = entry?.versions.find(
            (version) =>
              request.idempotencyKey !== undefined &&
              version.idempotencyKey === request.idempotencyKey,
          );
          if (entry && replayed) return { entry, version: replayed.version, replayed: true };
          const latestVersion = entry ? (entry.versions.at(-1)?.version ?? 0) : null;
          if (request.expectedLatest !== latestVersion) {
            throw new SkillConflictError(
              conflictMessage(name, latestVersion, request.expectedLatest),
            );
          }
          const version = (latestVersion ?? 0) + 1;
          const saved: z.infer<typeof versionEntrySchema> = { version, key };
          if (request.idempotencyKey !== undefined) saved.idempotencyKey = request.idempotencyKey;
          const next: SkillEntry = {
            liveVersion: request.activate ? version : (entry?.liveVersion ?? null),
            applicationMode: request.activate
              ? request.version.applicationMode
              : (entry?.applicationMode ?? request.version.applicationMode),
            createdAt: entry?.createdAt ?? createdAt,
            updatedAt: createdAt,
            versions: [...(entry?.versions ?? []), saved],
          };
          latest.skills[name] = next;
          return { entry: next, version, replayed: false };
        },
        request.expectedRevision,
      );
      if (outcome.replayed) {
        await this.#tombstone(key);
        const replay = await this.#replay(name, outcome.entry, request.idempotencyKey);
        if (replay) return replay;
        throw new SkillLifecycleError(`Skill "${name}" lost a replayed version.`);
      }
      return {
        head: toHead(name, outcome.entry),
        version: toRecord(outcome.version, document),
        replayed: false,
      };
    } catch (error) {
      await this.#tombstone(key);
      throw error;
    }
  }

  async updateHead(scope: SkillScope, update: SkillHeadUpdate): Promise<SkillHead> {
    const { name } = update;
    const entry = await this.#updateCatalog(
      scope,
      (catalog) => {
        const current = catalog.skills[name];
        if (!current) throw new SkillNotFoundError(name);
        const next: SkillEntry = { ...current, updatedAt: this.#now().toISOString() };
        if (update.liveVersion !== undefined) next.liveVersion = update.liveVersion;
        if (update.applicationMode !== undefined) next.applicationMode = update.applicationMode;
        catalog.skills[name] = next;
        return next;
      },
      update.expectedRevision,
    );
    return toHead(name, entry);
  }

  async remove(scope: SkillScope, names: readonly string[]): Promise<RemoveSkillsResult> {
    const removed = await this.#updateCatalog(scope, (catalog) => {
      const entries: Array<{ name: string; keys: string[] }> = [];
      for (const name of new Set(names)) {
        const entry = catalog.skills[name];
        if (!entry) continue;
        entries.push({ name, keys: entry.versions.map(({ key }) => key) });
        delete catalog.skills[name];
      }
      return entries;
    });
    await Promise.all(removed.flatMap(({ keys }) => keys.map((key) => this.#tombstone(key))));
    const removedNames = new Set(removed.map(({ name }) => name));
    return {
      removed: [...removedNames],
      notFound: [...new Set(names)].filter((name) => !removedNames.has(name)),
    };
  }
}
