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

/** Changes to a head. Omitted fields stay as they are. */
export interface SkillHeadPatch {
  readonly liveVersion?: number;
  readonly applicationMode?: SkillApplicationMode;
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
 * Storage failures reject; they never read as empty.
 */
export interface SkillRepository {
  /** Every skill in the scope. */
  listHeads(scope: SkillScope): Promise<SkillHead[]>;
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
  updateHead(scope: SkillScope, name: string, patch: SkillHeadPatch): Promise<SkillHead>;
  /** Deletes skills with every version. */
  remove(scope: SkillScope, names: readonly string[]): Promise<RemoveSkillsResult>;
}
