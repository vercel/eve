import {
  InvalidSkillContentError,
  InvalidSkillTransitionError,
  SkillConflictError,
  SkillNotFoundError,
  SkillVersionNotFoundError,
} from "./errors.ts";
import type { SkillHead, SkillRepository, SkillVersionRecord } from "./repository.ts";
import type {
  DeleteSkillsResult,
  SaveSkillInput,
  SkillApplicationMode,
  SkillChangeEvent,
  SkillSummary,
  SkillVersionStatus,
  StoredSkill,
} from "./types.ts";
import {
  isRoutingDescription,
  normalizeSkillInput,
  ROUTING_DESCRIPTION_REQUIREMENT,
  skillChecksum,
  validateSkillContent,
} from "./validation.ts";

const SAVE_ATTEMPTS = 5;

export interface SkillLimits {
  /** Always-on skills per scope. */
  maxAlwaysOn: number;
  /** Combined always-on markdown per scope, in characters. */
  maxAlwaysOnCharacters: number;
}

export const DEFAULT_LIMITS: SkillLimits = {
  maxAlwaysOn: 5,
  maxAlwaysOnCharacters: 20_000,
};

export interface SkillLifecycleOptions<S> {
  repository: SkillRepository<S>;
  limits?: Partial<SkillLimits>;
  onChange?: (event: SkillChangeEvent) => void | Promise<void>;
}

export interface SaveSkillOptions {
  /**
   * Which skill to version. Omitted, the normalized name is the id, so saving
   * an existing name adds a version to it. `null` creates a new skill with a
   * repository-assigned id. A string adds a version to that skill.
   */
  id?: string | null;
  /**
   * The latest version this save is based on (`null` for a new skill). A
   * stale value rejects with `SkillConflictError`. Omitted, the current latest
   * is used and a lost race is retried.
   */
  expectedLatest?: number | null;
  /** A repeated save with the same key returns the version it saved. */
  idempotencyKey?: string;
  /**
   * Whether the new version goes live. Omitted, only a clean (warning-free)
   * first version goes live and every other save is a draft.
   */
  activate?: boolean;
}

/** A version is live, older than the live version, or not yet published. */
export function versionStatus(version: number, liveVersion: number | null): SkillVersionStatus {
  if (version === liveVersion) return "active";
  if (liveVersion !== null && version < liveVersion) return "superseded";
  return "draft";
}

function materialize(version: SkillVersionRecord, head: SkillHead): StoredSkill {
  return {
    id: head.id,
    name: version.name,
    description: version.description,
    markdown: version.markdown,
    ownerKey: head.ownerKey,
    ownerLabel: version.ownerLabel,
    version: version.version,
    status: versionStatus(version.version, head.liveVersion),
    activeVersion: head.liveVersion,
    latestVersion: Math.max(head.latestVersion, version.version),
    checksum: version.checksum,
    validation: version.validation,
    applicationMode: head.applicationMode,
    createdAt: version.createdAt,
    updatedAt: head.updatedAt,
  };
}

function byName(a: { name: string; id: string }, b: { name: string; id: string }): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * The custom skill lifecycle over any `SkillRepository`: immutable versions,
 * one live version per skill, drafts, publish and rollback, application
 * modes, always-on limits, and validation.
 */
export class SkillLifecycle<S> {
  readonly #repository: SkillRepository<S>;
  readonly #limits: SkillLimits;
  readonly #onChange: SkillLifecycleOptions<S>["onChange"];

  constructor(options: SkillLifecycleOptions<S>) {
    this.#repository = options.repository;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#onChange = options.onChange;
  }

  async #emit(event: SkillChangeEvent): Promise<void> {
    try {
      await this.#onChange?.(event);
    } catch (error) {
      console.error("[custom-skills] onChange failed", error);
    }
  }

  async #requireHead(scope: S, id: string): Promise<SkillHead> {
    const head = await this.#repository.getHead(scope, id);
    if (!head) throw new SkillNotFoundError(id);
    return head;
  }

  async #requireVersion(scope: S, head: SkillHead, version: number): Promise<SkillVersionRecord> {
    const record = await this.#repository.getVersion(scope, head.id, version);
    if (!record) throw new SkillVersionNotFoundError(head.name, version);
    return record;
  }

  async #assertAlwaysOnCapacity(scope: S, id: string | null, markdown: string): Promise<void> {
    const others = (await this.listLive(scope)).filter(
      (skill) => skill.id !== id && skill.applicationMode === "always",
    );
    if (others.length >= this.#limits.maxAlwaysOn) {
      throw new InvalidSkillTransitionError(
        `At most ${this.#limits.maxAlwaysOn} skills in this scope can be always-on. Set another skill to on-demand first.`,
      );
    }
    const total = others.reduce((sum, skill) => sum + skill.markdown.length, markdown.length);
    if (total > this.#limits.maxAlwaysOnCharacters) {
      throw new InvalidSkillTransitionError(
        `Always-on skill instructions can total at most ${this.#limits.maxAlwaysOnCharacters} characters in this scope. Shorten this skill or set another skill to on-demand first.`,
      );
    }
  }

  /** Saves a new immutable version. See `SaveSkillOptions` for activation. */
  async save(
    scope: S,
    rawInput: SaveSkillInput,
    options: SaveSkillOptions = {},
  ): Promise<StoredSkill> {
    const input = normalizeSkillInput(rawInput);
    const validation = validateSkillContent(input);
    if (!validation.valid) throw new InvalidSkillContentError(validation.errors);
    const id = options.id === undefined ? input.name : options.id;

    for (let attempt = 1; ; attempt += 1) {
      const existing = id === null ? null : await this.#repository.getHead(scope, id);
      const applicationMode: SkillApplicationMode =
        input.applicationMode ?? existing?.applicationMode ?? "on-demand";
      if (applicationMode !== "always" && !isRoutingDescription(input.description)) {
        throw new InvalidSkillContentError([ROUTING_DESCRIPTION_REQUIREMENT]);
      }
      const activate = options.activate ?? (existing === null && validation.warnings.length === 0);
      if (applicationMode === "always") {
        if (activate) {
          await this.#assertAlwaysOnCapacity(scope, id, input.markdown);
        } else if (existing?.applicationMode !== "always" && existing?.liveVersion) {
          const live = await this.#requireVersion(scope, existing, existing.liveVersion);
          await this.#assertAlwaysOnCapacity(scope, id, live.markdown);
        }
      }

      try {
        const result = await this.#repository.appendVersion(scope, {
          id,
          expectedLatest:
            options.expectedLatest === undefined
              ? (existing?.latestVersion ?? null)
              : options.expectedLatest,
          idempotencyKey: options.idempotencyKey,
          version: {
            name: input.name,
            description: input.description,
            markdown: input.markdown,
            checksum: skillChecksum(input.name, input.description, input.markdown),
            validation,
          },
          head: { activate, applicationMode },
        });
        const stored = materialize(result.version, result.head);
        if (!result.replayed) await this.#emit({ kind: "saved", skill: stored });
        return stored;
      } catch (error) {
        const retry =
          error instanceof SkillConflictError &&
          options.expectedLatest === undefined &&
          id !== null &&
          attempt < SAVE_ATTEMPTS;
        if (!retry) throw error;
      }
    }
  }

  /** Every live skill in the scope. Storage failures throw rather than read as no skills. */
  async listLive(scope: S): Promise<StoredSkill[]> {
    const heads = await this.#repository.listHeads(scope);
    const skills = await Promise.all(
      heads.map(async (head) => {
        if (head.liveVersion === null) return null;
        const version = await this.#repository.getVersion(scope, head.id, head.liveVersion);
        if (!version) {
          console.warn("[custom-skills] live version is missing", {
            id: head.id,
            version: head.liveVersion,
          });
          return null;
        }
        return materialize(version, head);
      }),
    );
    return skills.filter((skill): skill is StoredSkill => skill !== null).sort(byName);
  }

  async listSummaries(scope: S): Promise<SkillSummary[]> {
    const heads = await this.#repository.listHeads(scope);
    const summaries = await Promise.all(
      heads.map(async (head): Promise<SkillSummary | null> => {
        const versions = await this.#repository.listVersions(scope, head.id);
        const latest = versions.at(-1);
        if (!latest) return null;
        const live = versions.find((version) => version.version === head.liveVersion);
        const liveVersion = live?.version ?? null;
        return {
          id: head.id,
          name: head.name,
          description: (live ?? latest).description,
          status: live ? "active" : "draft",
          activeVersion: liveVersion,
          latestVersion: latest.version,
          versionCount: versions.length,
          draftVersions: versions
            .filter((version) => versionStatus(version.version, liveVersion) === "draft")
            .map((version) => version.version),
          warningCount: latest.validation.warnings.length,
          applicationMode: head.applicationMode,
          updatedAt: head.updatedAt,
        };
      }),
    );
    return summaries.filter((summary): summary is SkillSummary => summary !== null).sort(byName);
  }

  /** Every version, newest first. */
  async listVersions(scope: S, id: string): Promise<StoredSkill[]> {
    const head = await this.#requireHead(scope, id);
    const versions = await this.#repository.listVersions(scope, id);
    if (versions.length === 0) throw new SkillNotFoundError(id);
    return versions
      .map((version) => materialize(version, head))
      .sort((a, b) => b.version - a.version);
  }

  /** One version; the latest when `version` is omitted. */
  async getVersion(scope: S, id: string, version?: number): Promise<StoredSkill> {
    const versions = await this.listVersions(scope, id);
    const target = version ?? versions[0]?.version ?? 1;
    const skill = versions.find((candidate) => candidate.version === target);
    if (!skill) throw new SkillVersionNotFoundError(id, target);
    return skill;
  }

  /** Makes an exact version live. */
  async publish(scope: S, id: string, target: number): Promise<StoredSkill> {
    const head = await this.#requireHead(scope, id);
    const version = await this.#requireVersion(scope, head, target);
    if (!version.validation.valid) {
      throw new InvalidSkillTransitionError(
        `Skill "${head.name}" version ${target} failed validation: ${version.validation.errors.join(" ")}`,
      );
    }
    if (head.applicationMode === "always") {
      await this.#assertAlwaysOnCapacity(scope, id, version.markdown);
    }
    const updated = await this.#repository.updateHead(scope, id, { liveVersion: target });
    const stored = materialize(version, updated);
    await this.#emit({ kind: "activated", skill: stored });
    return stored;
  }

  /** Makes an exact earlier version live again. */
  async rollback(scope: S, id: string, target: number): Promise<StoredSkill> {
    const head = await this.#requireHead(scope, id);
    const live = head.liveVersion;
    if (live === null) {
      throw new InvalidSkillTransitionError(
        `Skill "${head.name}" has no active version to roll back.`,
      );
    }
    if (target >= live) {
      throw new InvalidSkillTransitionError(
        `Skill "${head.name}" cannot roll back from version ${live} to version ${target}. Roll back only to an earlier version; publish a later one instead.`,
      );
    }
    return this.publish(scope, id, target);
  }

  /** Changes how the exact live version applies. */
  async setMode(
    scope: S,
    id: string,
    target: number,
    applicationMode: SkillApplicationMode,
  ): Promise<StoredSkill> {
    const head = await this.#requireHead(scope, id);
    if (head.liveVersion === null) {
      throw new InvalidSkillTransitionError(
        `Skill "${head.name}" has no active version. Activate a version before changing its application mode.`,
      );
    }
    if (head.liveVersion !== target) {
      throw new InvalidSkillTransitionError(
        `Skill "${head.name}" version ${target} is not active. The current active version is ${head.liveVersion}; review it before changing how it is applied.`,
      );
    }
    const version = await this.#requireVersion(scope, head, target);
    if (head.applicationMode === applicationMode) return materialize(version, head);
    if (applicationMode === "always") {
      await this.#assertAlwaysOnCapacity(scope, id, version.markdown);
    } else if (!isRoutingDescription(version.description)) {
      throw new InvalidSkillContentError([ROUTING_DESCRIPTION_REQUIREMENT]);
    }
    const updated = await this.#repository.updateHead(scope, id, { applicationMode });
    const stored = materialize(version, updated);
    await this.#emit({ kind: "mode", skill: stored });
    return stored;
  }

  /** Deletes skills and their whole version history. */
  async remove(scope: S, ids: readonly string[]): Promise<DeleteSkillsResult> {
    const result = await this.#repository.remove(scope, [...new Set(ids)]);
    const owners = new Set(result.removed.map(({ ownerKey }) => ownerKey));
    for (const ownerKey of owners) {
      await this.#emit({
        kind: "deleted",
        ownerKey,
        ids: result.removed.filter((skill) => skill.ownerKey === ownerKey).map(({ id }) => id),
      });
    }
    return { deleted: result.removed.map(({ id }) => id), notFound: [...result.notFound] };
  }
}
