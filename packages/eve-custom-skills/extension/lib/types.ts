import type { ConversationContext, SessionAuthContext, SessionInfo } from "eve/context";

export type SkillVersionStatus = "active" | "draft" | "superseded";

/**
 * How a skill version applies when it is live. `always` injects it into the
 * system prompt every turn, `on-demand` advertises it for loading, and
 * `deferred` keeps it out of the prompt until `eve__search` finds it.
 */
export type SkillApplicationMode = "always" | "on-demand" | "deferred";

export const SKILL_APPLICATION_MODES = ["always", "on-demand", "deferred"] as const;

/** What validation found in a version. Errors block a save; warnings hold a first version in draft. */
export interface SkillValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/** Who saved a version, for audit. */
export interface SkillAuthor {
  /** The saver's eve principal, or `null` when the session had none. */
  readonly principalId: string | null;
  /** A readable name: email, user name, or principal. */
  readonly label: string;
}

/**
 * A set of skills that apply together, such as one person's skills or the
 * skills everyone in a Slack channel shares.
 */
export interface SkillScope {
  /**
   * What the model passes as `scope` to the lifecycle tools, such as
   * `personal` or `channel`. Unique among the scopes of one turn.
   */
  readonly name: string;
  /**
   * Where the scope's skills are stored, unique per owner across every scope,
   * such as `user:<principal>` or `space:<space id>`. The built-in repository
   * hashes it, so any string works.
   */
  readonly key: string;
  /** Who the skills are for, as the model and approval cards name them: `you`, `everyone in this channel`. */
  readonly label: string;
  /**
   * Whether more than one person shares the scope. The default approval rule
   * asks before a change goes live in a shared scope.
   */
  readonly shared: boolean;
  /** Lists and loads the scope's skills but refuses every change. */
  readonly readOnly?: boolean;
  /**
   * Prefix for the names the scope's on-demand skills load under: with
   * `channel`, skill `deploy` loads as `channel_deploy`. Skill names never
   * contain `_`, so a prefixed name can't collide with another scope's. Use
   * lowercase letters, digits, and hyphens. At most one scope of a turn may
   * omit it.
   */
  readonly loadPrefix?: string;
  /** Anything a custom repository needs to address the scope, such as a tenant ID. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** What a scope resolver reads: the session and where its conversation happens. */
export interface SkillScopeContext {
  readonly session: Pick<SessionInfo, "id" | "auth">;
  readonly conversation?: ConversationContext;
}

/**
 * The scopes whose skills apply on a turn, in precedence order. The first is
 * the default for lifecycle tools. Runs before every model call and tool call,
 * so keep it fast.
 */
export type SkillScopeResolver = (
  ctx: SkillScopeContext,
) => readonly SkillScope[] | Promise<readonly SkillScope[]>;

/** One saved version of a skill, with its status relative to the live version. */
export interface StoredSkill {
  readonly name: string;
  readonly version: number;
  readonly status: SkillVersionStatus;
  readonly liveVersion: number | null;
  readonly latestVersion: number;
  readonly description: string;
  readonly instructions: string;
  /** How this version applies when it is live. For the live version, the current mode. */
  readonly applicationMode: SkillApplicationMode;
  readonly checksum: string;
  readonly validation: SkillValidation;
  readonly savedBy: SkillAuthor;
  readonly createdAt: string;
}

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly status: "active" | "draft";
  readonly liveVersion: number | null;
  readonly latestVersion: number;
  readonly draftVersions: readonly number[];
  readonly warningCount: number;
  readonly applicationMode: SkillApplicationMode;
  readonly updatedAt: string;
}

/** What a skill's live version was before a change. */
export interface SkillLiveState {
  readonly version: number | null;
  readonly applicationMode: SkillApplicationMode | null;
}

interface SkillChangeBase {
  readonly scope: SkillScope;
  /** Who asked for the change. */
  readonly actor: SessionAuthContext | null;
  /** Who approved it, when a person did. */
  readonly approvedBy?: SessionAuthContext;
  readonly sessionId: string;
}

/**
 * A successful change, for audit logs or mirroring an inventory. `saved` is a
 * new version, `published` makes a version live (including a rollback), and
 * `mode` changes how the live version applies.
 */
export type SkillChangeEvent =
  | (SkillChangeBase & {
      readonly kind: "saved" | "published" | "mode";
      readonly skill: StoredSkill;
      readonly previous: SkillLiveState;
    })
  | (SkillChangeBase & {
      readonly kind: "removed";
      readonly names: readonly string[];
    });

/** The lifecycle tools that change skills. */
export type SkillAction = "create" | "publish" | "rollback" | "set_mode" | "remove";

/** One skill a change affects, as the approval rule and card see it. */
export interface SkillApprovalTarget {
  readonly name: string;
  /** The version the change saves or makes live. Absent for `remove`. */
  readonly version?: number;
  readonly description?: string;
  readonly instructions?: string;
  readonly applicationMode?: SkillApplicationMode;
  readonly warnings: readonly string[];
  /** What is live now. */
  readonly live: SkillLiveState & { readonly instructions?: string };
}

/** A pending change, for the approval rule. */
export interface SkillApprovalRequest {
  readonly action: SkillAction;
  readonly scope: SkillScope;
  readonly caller: SessionAuthContext | null;
  /**
   * Whether the change alters what applies on later turns. A draft save
   * doesn't; publishing, a mode change, a first version that goes live, and a
   * removal do.
   */
  readonly changesLive: boolean;
  readonly targets: readonly SkillApprovalTarget[];
}

/** `allow` runs the change, `ask` waits for a person, `{ deny }` refuses with a reason the model sees. */
export type SkillApprovalDecision = "allow" | "ask" | { readonly deny: string };

/** Decides whether a change to custom skills runs, asks a person, or is refused. */
export type SkillApprovalRule = (
  request: SkillApprovalRequest,
) => SkillApprovalDecision | Promise<SkillApprovalDecision>;
