import type { SkillApplicationMode, SkillAuthor, SkillScope, SkillValidation } from "./types.ts";

/**
 * A skill's state without any version body. `id` is the skill's stable
 * identity; `name` is unique within the scope and is how people and the model
 * refer to it.
 */
export interface SkillHead {
  readonly id: string;
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
  readonly id: string;
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
  readonly id: string;
  readonly liveVersion?: number;
  readonly applicationMode?: SkillApplicationMode;
  /** Rejects with `SkillConflictError` unless the scope is still at this revision. */
  readonly expectedRevision?: string | null;
}

export interface AppendVersionRequest {
  /**
   * The skill's ID. For a new skill (`expectedLatest: null`) it is a fresh
   * UUID the repository should store; a repository that assigns its own IDs
   * may use one instead and return it in `head.id`. Never reuse an ID, even
   * after the skill is removed: approvals are bound to a skill's ID and
   * version, so a reused ID would let a recreated skill's content stand in
   * for what a person approved.
   */
  readonly id: string;
  /** Unique within the scope. A new skill whose name is taken rejects with `SkillConflictError`. */
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
  /** IDs of the skills removed. */
  readonly removed: readonly string[];
  /** IDs that didn't exist. */
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
  /** The skill with this name in the scope. */
  getHead(scope: SkillScope, name: string): Promise<SkillHead | null>;
  /** Every version of a skill, oldest first. */
  listVersions(scope: SkillScope, id: string): Promise<SkillVersionRecord[]>;
  /** The requested versions, in request order, with `null` for any that don't exist. */
  getVersions(
    scope: SkillScope,
    refs: readonly SkillVersionRef[],
  ): Promise<Array<SkillVersionRecord | null>>;
  appendVersion(scope: SkillScope, request: AppendVersionRequest): Promise<AppendVersionResult>;
  /** Rejects with `SkillNotFoundError` when the skill doesn't exist. */
  updateHead(scope: SkillScope, update: SkillHeadUpdate): Promise<SkillHead>;
  /** Deletes skills with every version. */
  remove(scope: SkillScope, ids: readonly string[]): Promise<RemoveSkillsResult>;
  /**
   * Every scope that has held skills, as it was last written, so an admin
   * view or library can list skills across users and conversations. Optional:
   * a repository that can't enumerate its scopes omits it.
   */
  listScopes?(): Promise<SkillScope[]>;
}
