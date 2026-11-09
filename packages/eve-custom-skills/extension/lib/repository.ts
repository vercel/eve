import type { SkillApplicationMode, SkillAuthor, SkillScope, SkillValidation } from "./types.ts";

/** A skill's state without any version body. Skills are addressed by name within a scope. */
export interface SkillHead {
  readonly name: string;
  readonly liveVersion: number | null;
  readonly latestVersion: number;
  /** How the live version applies. */
  readonly applicationMode: SkillApplicationMode;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One immutable saved version. */
export interface SkillVersionRecord {
  readonly version: number;
  readonly description: string;
  readonly markdown: string;
  /** How the version applies once it is published. */
  readonly applicationMode: SkillApplicationMode;
  readonly checksum: string;
  readonly validation: SkillValidation;
  readonly savedBy: SkillAuthor;
  readonly createdAt: string;
}

/** One version to read in a batch. */
export interface SkillVersionRef {
  readonly name: string;
  readonly version: number;
}

/** Every skill in a scope, and the scope's revision when it was read. */
export interface SkillCatalog {
  readonly heads: readonly SkillHead[];
  /**
   * Changes whenever any skill in the scope changes, or `null` for a scope
   * that has never been written. Writes that pass it back as
   * `expectedRevision` fail when the scope changed since, which keeps
   * scope-wide limits and the reviewed live version from racing.
   */
  readonly revision: string | null;
}

/** A change to a skill's head. Omitted fields stay as they are. */
export interface SkillHeadUpdate {
  readonly name: string;
  readonly liveVersion?: number;
  readonly applicationMode?: SkillApplicationMode;
  /** Rejects with `SkillConflictError` unless the scope is still at this revision. */
  readonly expectedRevision?: string | null;
}

export interface AppendVersionRequest {
  readonly name: string;
  /**
   * The latest version the caller saw, or `null` when the skill must not exist
   * yet. A mismatch rejects with `SkillConflictError`.
   */
  readonly expectedLatest: number | null;
  /** A repeated append with the same key returns the version it saved. */
  readonly idempotencyKey?: string;
  /** Rejects with `SkillConflictError` unless the scope is still at this revision. */
  readonly expectedRevision?: string | null;
  readonly version: Omit<SkillVersionRecord, "version" | "createdAt">;
  /** Whether the new version goes live, which also sets the head's mode to the version's. */
  readonly activate: boolean;
}

export interface AppendVersionResult {
  readonly head: SkillHead;
  readonly version: SkillVersionRecord;
  /** True when an earlier append with the same idempotency key was returned. */
  readonly replayed: boolean;
}

export interface RemoveSkillsResult {
  readonly removed: readonly string[];
  readonly notFound: readonly string[];
}

/**
 * Where custom skills live. The lifecycle (validation, drafts, publishing,
 * rollback, application modes, limits) runs on top of this interface.
 * Storage failures reject; they never read as empty. Versions are numbered
 * 1, 2, 3… with no gaps.
 */
export interface SkillRepository {
  /** Every skill in the scope, with the scope's revision. */
  listHeads(scope: SkillScope): Promise<SkillCatalog>;
  getHead(scope: SkillScope, name: string): Promise<SkillHead | null>;
  /** Every version of a skill, oldest first. */
  listVersions(scope: SkillScope, name: string): Promise<SkillVersionRecord[]>;
  /** The requested versions, in request order, with `null` for any that don't exist. */
  getVersions(
    scope: SkillScope,
    refs: readonly SkillVersionRef[],
  ): Promise<Array<SkillVersionRecord | null>>;
  appendVersion(scope: SkillScope, request: AppendVersionRequest): Promise<AppendVersionResult>;
  /** Rejects with `SkillNotFoundError` when the skill doesn't exist. */
  updateHead(scope: SkillScope, update: SkillHeadUpdate): Promise<SkillHead>;
  /** Deletes skills with every version. */
  remove(scope: SkillScope, names: readonly string[]): Promise<RemoveSkillsResult>;
}
