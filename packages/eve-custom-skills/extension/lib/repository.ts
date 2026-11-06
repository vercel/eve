import type { SkillApplicationMode, SkillValidation } from "./types.ts";

/**
 * A skill's state without any version body: which version is live, the
 * newest version, and how the live version applies.
 */
export interface SkillHead {
  /** Stable identifier. Skills the tools create use their name. */
  readonly id: string;
  readonly name: string;
  readonly ownerKey: string;
  readonly liveVersion: number | null;
  readonly latestVersion: number;
  readonly applicationMode: SkillApplicationMode;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One immutable saved version. */
export interface SkillVersionRecord {
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly markdown: string;
  /** Who saved this version. */
  readonly ownerLabel: string;
  readonly checksum: string;
  readonly validation: SkillValidation;
  readonly createdAt: string;
}

/** Changes to a head. Omitted fields stay as they are. */
export interface SkillHeadPatch {
  readonly liveVersion?: number;
  readonly applicationMode?: SkillApplicationMode;
}

export interface AppendVersionRequest {
  /**
   * The skill to add a version to. `null` creates a new skill with an id the
   * repository assigns; a new skill may also be created under a chosen id.
   */
  readonly id: string | null;
  /**
   * The latest version the caller saw, or `null` when the skill must not exist
   * yet. A mismatch rejects with `SkillConflictError`.
   */
  readonly expectedLatest: number | null;
  /** A repeated append with the same key returns the version it saved. */
  readonly idempotencyKey?: string;
  readonly version: Pick<
    SkillVersionRecord,
    "name" | "description" | "markdown" | "checksum" | "validation"
  >;
  /** Whether the new version goes live, and the mode written with it. */
  readonly head: {
    readonly activate: boolean;
    readonly applicationMode: SkillApplicationMode;
  };
}

export interface AppendVersionResult {
  readonly head: SkillHead;
  readonly version: SkillVersionRecord;
  /** True when an earlier append with the same idempotency key was returned. */
  readonly replayed: boolean;
}

export interface RemoveSkillsResult {
  readonly removed: ReadonlyArray<{ readonly id: string; readonly ownerKey: string }>;
  readonly notFound: readonly string[];
}

/**
 * Where custom skills live. The lifecycle (validation, drafts, publishing,
 * rollback, application modes, always-on limits) runs on top of this
 * interface and never inspects the scope `S`.
 */
export interface SkillRepository<S> {
  /** Every skill in the scope. Storage failures reject; they never read as empty. */
  listHeads(scope: S): Promise<SkillHead[]>;
  getHead(scope: S, id: string): Promise<SkillHead | null>;
  /** Every version of a skill, oldest first. */
  listVersions(scope: S, id: string): Promise<SkillVersionRecord[]>;
  getVersion(scope: S, id: string, version: number): Promise<SkillVersionRecord | null>;
  appendVersion(scope: S, request: AppendVersionRequest): Promise<AppendVersionResult>;
  updateHead(scope: S, id: string, patch: SkillHeadPatch): Promise<SkillHead>;
  remove(scope: S, ids: readonly string[]): Promise<RemoveSkillsResult>;
}
