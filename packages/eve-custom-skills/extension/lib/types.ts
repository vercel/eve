export type SkillVersionStatus = "active" | "draft" | "superseded";

/**
 * How a skill's live version applies. `always` injects it into the system
 * prompt every turn, `on-demand` advertises it for loading, and `deferred`
 * keeps it out of the prompt until `eve__search` finds it.
 */
export type SkillApplicationMode = "always" | "on-demand" | "deferred";

export const SKILL_APPLICATION_MODES = ["always", "on-demand", "deferred"] as const;

/** The subset of eve's `SessionAuthContext` the extension reads. */
export interface SkillAuth {
  readonly principalId?: string;
  readonly principalType?: string;
  readonly authenticator?: string;
  readonly subject?: string;
  readonly attributes?: Readonly<Record<string, string | readonly string[]>>;
}

export interface SkillValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface SaveSkillInput {
  name: string;
  description: string;
  markdown: string;
  applicationMode?: SkillApplicationMode;
}

export interface StoredSkill {
  /** The repository's id for the skill; the name for skills the tools create. */
  id: string;
  name: string;
  description: string;
  markdown: string;
  ownerKey: string;
  ownerLabel: string;
  version: number;
  status: SkillVersionStatus;
  activeVersion: number | null;
  latestVersion: number;
  checksum: string;
  validation: SkillValidation;
  applicationMode: SkillApplicationMode;
  createdAt: string;
  updatedAt: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  status: "active" | "draft";
  activeVersion: number | null;
  latestVersion: number;
  versionCount: number;
  draftVersions: number[];
  warningCount: number;
  applicationMode: SkillApplicationMode;
  updatedAt: string;
}

export interface DeleteSkillsResult {
  deleted: string[];
  notFound: string[];
}

/**
 * One owner whose skills apply on a turn. `scope` is a stable identifier the
 * model passes back to lifecycle tools (`personal`, `channel`, ...).
 * `ownerKey` addresses storage and must be unique per owner across scopes.
 */
export interface SkillScope {
  readonly scope: string;
  readonly ownerKey: string;
  /** Who saved a version, recorded on it for audit. */
  readonly ownerLabel: string;
  /** Prefix for the loadable skill name, e.g. `channel-`. Empty for personal. */
  readonly loadNamePrefix: string;
  /** Names the scope in prompts: `personal`, `channel`. */
  readonly title: string;
  /** Who may ask for a skill by name: `the user`. */
  readonly requester: string;
  /** Who turned always-on skills on, as a sentence subject: `The user`. */
  readonly setBy: string;
}

/** A change a consumer can mirror elsewhere, such as an inventory table. */
export type SkillChangeEvent =
  | {
      readonly kind: "saved" | "activated" | "mode";
      readonly skill: StoredSkill;
    }
  | {
      readonly kind: "deleted";
      readonly ownerKey: string;
      readonly ids: readonly string[];
    };
