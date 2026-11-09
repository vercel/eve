import { randomUUID } from "node:crypto";

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

/**
 * The storage layout version, part of every key. A later layout lives beside
 * this one under its own prefix, so it can migrate documents in place of
 * reinterpreting them.
 */
const LAYOUT = "v1";
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
  /** Skills by ID. */
  skills: z.record(z.string(), skillEntrySchema),
});

const scopeEntrySchema = z.object({
  name: z.string(),
  label: z.string(),
  shared: z.boolean(),
  readOnly: z.boolean().optional(),
  loadPrefix: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Where the scope's documents live, under the namespace. */
  path: z.string(),
  updatedAt: z.string(),
});

const indexSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** Every scope that has held skills, by scope key. */
  scopes: z.record(z.string(), scopeEntrySchema),
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
type ScopeIndex = z.infer<typeof indexSchema>;
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
 * Encodes a scope key or skill ID as one readable, reversible path segment:
 * letters, digits, `-`, and `_` stay, and every other UTF-8 byte becomes `~`
 * and two hex digits, so `space:slack:T1:C1` is stored as
 * `space~3aslack~3aT1~3aC1`.
 */
export function encodePathSegment(value: string): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);
    encoded += /[A-Za-z0-9_-]/.test(char) ? char : `~${byte.toString(16).padStart(2, "0")}`;
  }
  return encoded;
}

/**
 * Stores skills in a memory document backend, in a layout meant to be read by
 * other tools as well as this repository:
 *
 * ```text
 * <namespace>/v1/index.json                               every scope, with its descriptor
 * <namespace>/v1/scopes/<scope key>/catalog.json          the scope's skills by ID, and their version indexes
 * <namespace>/v1/scopes/<scope key>/skills/<id>/<uuid>.json  one immutable version
 * ```
 *
 * Scope keys and skill IDs are encoded with `encodePathSegment`. The index
 * makes the store listable, through `listScopes`, even on backends that can't
 * list keys. Catalog writes are compare-and-swap, and the catalog's version is
 * the scope's revision. A version's content is written before the catalog
 * entry that numbers it. Removing a skill overwrites its version documents
 * with an empty tombstone, because the backend has no delete; a backend that
 * keeps object history still holds the old content.
 */
export function documentRepository(options: DocumentRepositoryOptions): SkillRepository {
  return new DocumentSkillRepository(options);
}

function toHead(id: string, entry: SkillEntry): SkillHead {
  return {
    id,
    name: entry.name,
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

function scopeDescriptor(scope: SkillScope, path: string) {
  return {
    name: scope.name,
    label: scope.label,
    shared: scope.shared,
    ...(scope.readOnly !== undefined && { readOnly: scope.readOnly }),
    ...(scope.loadPrefix !== undefined && { loadPrefix: scope.loadPrefix }),
    ...(scope.metadata !== undefined && { metadata: { ...scope.metadata } }),
    path,
  };
}

class DocumentSkillRepository implements SkillRepository {
  readonly #backend: MemoryDocumentBackend;
  readonly #root: string;
  readonly #now: () => Date;
  readonly #signal = new AbortController().signal;
  /** Scope descriptors this instance already recorded in the index. */
  readonly #indexed = new Map<string, string>();

  constructor(options: DocumentRepositoryOptions) {
    this.#backend = options.backend;
    this.#root = `${options.namespace ?? "custom-skills"}/${LAYOUT}`;
    this.#now = options.now ?? (() => new Date());
  }

  #scopePath(scope: SkillScope): string {
    return `scopes/${encodePathSegment(scope.key)}`;
  }

  #catalogKey(scope: SkillScope): string {
    return `${this.#root}/${this.#scopePath(scope)}/catalog.json`;
  }

  async #read<T>(key: string, schema: z.ZodType<T>): Promise<{ value: T; version: string } | null> {
    const document = await this.#backend.read({ key, signal: this.#signal });
    if (!document || document.content === "") return null;
    return { value: schema.parse(JSON.parse(document.content)), version: document.version };
  }

  /** Applies `change` to the latest document, retrying when another write lands first. */
  async #update<T, R>(input: {
    readonly key: string;
    readonly schema: z.ZodType<T>;
    readonly empty: () => T;
    readonly change: (value: T) => R;
    readonly expectedVersion?: string | null;
  }): Promise<R> {
    for (let attempt = 1; ; attempt += 1) {
      const current = await this.#read(input.key, input.schema);
      const version = current?.version ?? null;
      if (input.expectedVersion !== undefined && version !== input.expectedVersion) {
        throw new SkillConflictError(
          "The skills in this scope changed while this change was checked. Try again.",
        );
      }
      const value = current?.value ?? input.empty();
      const before = JSON.stringify(value);
      const result = input.change(value);
      if (JSON.stringify(value) === before) return result;
      try {
        await this.#backend.write({
          key: input.key,
          content: JSON.stringify(value),
          expectedVersion: version,
          signal: this.#signal,
        });
        return result;
      } catch (error) {
        if (!MemoryDocumentConflictError.is(error) || attempt >= MAX_CONFLICT_RETRIES) throw error;
      }
    }
  }

  async #readCatalog(scope: SkillScope): Promise<{ catalog: Catalog; version: string | null }> {
    const read = await this.#read(this.#catalogKey(scope), catalogSchema);
    return read
      ? { catalog: read.value, version: read.version }
      : { catalog: { schemaVersion: SCHEMA_VERSION, skills: {} }, version: null };
  }

  #updateCatalog<T>(
    scope: SkillScope,
    change: (catalog: Catalog) => T,
    expectedRevision?: string | null,
  ): Promise<T> {
    return this.#update({
      key: this.#catalogKey(scope),
      schema: catalogSchema,
      empty: (): Catalog => ({ schemaVersion: SCHEMA_VERSION, skills: {} }),
      change,
      ...(expectedRevision !== undefined && { expectedVersion: expectedRevision }),
    });
  }

  /** Records the scope in the store's index, so `listScopes` can find it. */
  async #index(scope: SkillScope): Promise<void> {
    const descriptor = scopeDescriptor(scope, this.#scopePath(scope));
    const serialized = JSON.stringify(descriptor);
    if (this.#indexed.get(scope.key) === serialized) return;
    await this.#update({
      key: `${this.#root}/index.json`,
      schema: indexSchema,
      empty: (): ScopeIndex => ({ schemaVersion: SCHEMA_VERSION, scopes: {} }),
      change: (index) => {
        const existing = index.scopes[scope.key];
        if (existing) {
          const { updatedAt: _updatedAt, ...rest } = existing;
          if (JSON.stringify(rest) === serialized) return;
        }
        index.scopes[scope.key] = { ...descriptor, updatedAt: this.#now().toISOString() };
      },
    });
    this.#indexed.set(scope.key, serialized);
  }

  async #readVersion(key: string): Promise<VersionDocument | null> {
    return (await this.#read(key, versionDocumentSchema))?.value ?? null;
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
    id: string,
    entry: SkillEntry,
    idempotencyKey: string | undefined,
  ): Promise<AppendVersionResult | null> {
    if (idempotencyKey === undefined) return null;
    const saved = entry.versions.find((version) => version.idempotencyKey === idempotencyKey);
    if (!saved) return null;
    const document = await this.#readVersion(saved.key);
    if (!document) return null;
    return { head: toHead(id, entry), version: toRecord(saved.version, document), replayed: true };
  }

  async listScopes(): Promise<SkillScope[]> {
    const index = await this.#read(`${this.#root}/index.json`, indexSchema);
    return Object.entries(index?.value.scopes ?? {}).map(
      ([key, { path: _path, updatedAt: _updatedAt, metadata, ...scope }]) => ({
        ...scope,
        key,
        ...(metadata !== undefined && { metadata }),
      }),
    );
  }

  async listHeads(scope: SkillScope): Promise<SkillCatalog> {
    const { catalog, version } = await this.#readCatalog(scope);
    return {
      heads: Object.entries(catalog.skills).map(([id, entry]) => toHead(id, entry)),
      revision: version,
    };
  }

  async getHead(scope: SkillScope, name: string): Promise<SkillHead | null> {
    const { catalog } = await this.#readCatalog(scope);
    const found = Object.entries(catalog.skills).find(([, entry]) => entry.name === name);
    return found ? toHead(found[0], found[1]) : null;
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

  async getVersions(
    scope: SkillScope,
    refs: readonly SkillVersionRef[],
  ): Promise<Array<SkillVersionRecord | null>> {
    if (refs.length === 0) return [];
    const { catalog } = await this.#readCatalog(scope);
    return Promise.all(
      refs.map(async ({ id, version }) => {
        const saved = catalog.skills[id]?.versions.find((entry) => entry.version === version);
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
    const { id, name } = request;
    const { catalog } = await this.#readCatalog(scope);
    const existing = catalog.skills[id];
    if (existing) {
      const replay = await this.#replay(id, existing, request.idempotencyKey);
      if (replay) return replay;
    }
    const current = existing ? (existing.versions.at(-1)?.version ?? 0) : null;
    if (request.expectedLatest !== current) {
      throw new SkillConflictError(conflictMessage(name, current, request.expectedLatest));
    }
    await this.#index(scope);

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
    const key = `${this.#root}/${this.#scopePath(scope)}/skills/${encodePathSegment(id)}/${randomUUID()}.json`;
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
          const entry = latest.skills[id];
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
          if (
            entry === undefined &&
            Object.values(latest.skills).some((other) => other.name === name)
          ) {
            throw new SkillConflictError(conflictMessage(name, 0, null));
          }
          const version = (latestVersion ?? 0) + 1;
          const saved: z.infer<typeof versionEntrySchema> = { version, key };
          if (request.idempotencyKey !== undefined) saved.idempotencyKey = request.idempotencyKey;
          const next: SkillEntry = {
            name: entry?.name ?? name,
            liveVersion: request.activate ? version : (entry?.liveVersion ?? null),
            applicationMode: request.activate
              ? request.version.applicationMode
              : (entry?.applicationMode ?? request.version.applicationMode),
            createdAt: entry?.createdAt ?? createdAt,
            updatedAt: createdAt,
            versions: [...(entry?.versions ?? []), saved],
          };
          latest.skills[id] = next;
          return { entry: next, version, replayed: false };
        },
        request.expectedRevision,
      );
      if (outcome.replayed) {
        await this.#tombstone(key);
        const replay = await this.#replay(id, outcome.entry, request.idempotencyKey);
        if (replay) return replay;
        throw new SkillLifecycleError(`Skill "${name}" lost a replayed version.`);
      }
      return {
        head: toHead(id, outcome.entry),
        version: toRecord(outcome.version, document),
        replayed: false,
      };
    } catch (error) {
      await this.#tombstone(key);
      throw error;
    }
  }

  async updateHead(scope: SkillScope, update: SkillHeadUpdate): Promise<SkillHead> {
    const { id } = update;
    const entry = await this.#updateCatalog(
      scope,
      (catalog) => {
        const current = catalog.skills[id];
        if (!current) throw new SkillNotFoundError(id);
        const next: SkillEntry = { ...current, updatedAt: this.#now().toISOString() };
        if (update.liveVersion !== undefined) next.liveVersion = update.liveVersion;
        if (update.applicationMode !== undefined) next.applicationMode = update.applicationMode;
        catalog.skills[id] = next;
        return next;
      },
      update.expectedRevision,
    );
    return toHead(id, entry);
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
      removed: [...removedIds],
      notFound: [...new Set(ids)].filter((id) => !removedIds.has(id)),
    };
  }
}
