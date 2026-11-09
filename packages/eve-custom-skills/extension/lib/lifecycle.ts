import {
  InvalidSkillContentError,
  InvalidSkillTransitionError,
  SkillConflictError,
  SkillNotFoundError,
  SkillVersionNotFoundError,
} from "./errors.ts";
import type { SkillCatalog, SkillHead, SkillRepository, SkillVersionRecord } from "./repository.ts";
import type {
  SkillApplicationMode,
  SkillAuthor,
  SkillLiveState,
  SkillScope,
  SkillSummary,
  SkillValidation,
  SkillVersionStatus,
  StoredSkill,
} from "./types.ts";
import {
  DEFAULT_LIMITS,
  isRoutingDescription,
  normalizeSkillContent,
  normalizeSkillName,
  ROUTING_DESCRIPTION_REQUIREMENT,
  skillChecksum,
  validateSkillContent,
  type SkillLimits,
} from "./validation.ts";

const SAVE_ATTEMPTS = 5;

export interface SaveSkillInput {
  readonly name: string;
  readonly description: string;
  readonly markdown: string;
  readonly applicationMode?: SkillApplicationMode;
}

/** What a save would do, computed before it runs so an approval rule can judge it. */
export interface SavePlan {
  readonly name: string;
  readonly description: string;
  readonly markdown: string;
  readonly applicationMode: SkillApplicationMode;
  readonly validation: SkillValidation;
  /** The version number the save would get. */
  readonly version: number;
  /** Whether the version would go live: a clean first version does. */
  readonly activates: boolean;
  readonly live: SkillLiveState & { readonly instructions?: string };
  /** The scope's revision the plan was made at. */
  readonly revision: string | null;
}

/** A planned publish, rollback, or mode change, at the scope revision it was checked against. */
export interface HeadPlan {
  readonly head: SkillHead;
  readonly version: SkillVersionRecord;
  readonly revision: string | null;
}

export interface SaveSkillOptions {
  readonly savedBy: SkillAuthor;
  /** A repeated save with the same key returns the version it saved. */
  readonly idempotencyKey?: string;
  /** Holds the version in draft even when it would go live. */
  readonly draft?: boolean;
}

export interface SkillChange {
  readonly skill: StoredSkill;
  readonly previous: SkillLiveState;
}

/** A version is live, older than the live version, or not yet published. */
export function versionStatus(version: number, liveVersion: number | null): SkillVersionStatus {
  if (version === liveVersion) return "active";
  if (liveVersion !== null && version < liveVersion) return "superseded";
  return "draft";
}

function liveState(head: SkillHead | null): SkillLiveState {
  return head?.liveVersion == null
    ? { version: null, applicationMode: null }
    : { version: head.liveVersion, applicationMode: head.applicationMode };
}

function materialize(name: string, version: SkillVersionRecord, head: SkillHead): StoredSkill {
  const live = version.version === head.liveVersion;
  return {
    name,
    version: version.version,
    status: versionStatus(version.version, head.liveVersion),
    liveVersion: head.liveVersion,
    latestVersion: Math.max(head.latestVersion, version.version),
    description: version.description,
    instructions: version.markdown,
    applicationMode: live ? head.applicationMode : version.applicationMode,
    checksum: version.checksum,
    validation: version.validation,
    savedBy: version.savedBy,
    createdAt: version.createdAt,
  };
}

/**
 * The custom skill lifecycle over any `SkillRepository`: immutable versions,
 * one live version per skill, drafts, publish and rollback, application
 * modes, limits, and validation.
 */
export class SkillLifecycle {
  readonly #repository: SkillRepository;
  readonly limits: SkillLimits;

  constructor(options: { repository: SkillRepository; limits?: Partial<SkillLimits> }) {
    this.#repository = options.repository;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  normalizeName(raw: string): string {
    return normalizeSkillName(raw, this.limits.maxNameLength);
  }

  async #requireHead(scope: SkillScope, name: string): Promise<SkillHead> {
    const head = await this.#repository.getHead(scope, name);
    if (!head) throw new SkillNotFoundError(name);
    return head;
  }

  /** The scope's skills and revision, with `name`'s head, which must exist. */
  async #snapshot(
    scope: SkillScope,
    name: string,
  ): Promise<{ catalog: SkillCatalog; head: SkillHead }> {
    const catalog = await this.#repository.listHeads(scope);
    const head = catalog.heads.find((candidate) => candidate.name === name);
    if (!head) throw new SkillNotFoundError(name);
    return { catalog, head };
  }

  /**
   * Retries a planned write that lost a race to another change in the scope,
   * planning it again against the newer state.
   */
  async #retrying<T>(write: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await write();
      } catch (error) {
        if (!(error instanceof SkillConflictError) || attempt >= SAVE_ATTEMPTS) throw error;
      }
    }
  }

  async #requireVersion(
    scope: SkillScope,
    name: string,
    version: number,
  ): Promise<SkillVersionRecord> {
    const [record] = await this.#repository.getVersions(scope, [{ name, version }]);
    if (!record) throw new SkillVersionNotFoundError(name, version);
    return record;
  }

  async #liveSkills(scope: SkillScope, heads: readonly SkillHead[]): Promise<StoredSkill[]> {
    const live = heads.filter(
      (head): head is SkillHead & { liveVersion: number } => head.liveVersion !== null,
    );
    const versions = await this.#repository.getVersions(
      scope,
      live.map(({ name, liveVersion }) => ({ name, version: liveVersion })),
    );
    return live
      .flatMap((head, index) => {
        const version = versions[index];
        if (version) return [materialize(head.name, version, head)];
        console.warn("[custom-skills] live version is missing", {
          name: head.name,
          version: head.liveVersion,
        });
        return [];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async #assertAlwaysOnCapacity(
    scope: SkillScope,
    catalog: SkillCatalog,
    name: string,
    markdown: string,
  ): Promise<void> {
    const others = (await this.#liveSkills(scope, catalog.heads)).filter(
      (skill) => skill.name !== name && skill.applicationMode === "always",
    );
    if (others.length >= this.limits.maxAlwaysOn) {
      throw new InvalidSkillTransitionError(
        `At most ${this.limits.maxAlwaysOn} skills in this scope can be always-on. Set another skill to on-demand first.`,
      );
    }
    const total = others.reduce((sum, skill) => sum + skill.instructions.length, markdown.length);
    if (total > this.limits.maxAlwaysOnCharacters) {
      throw new InvalidSkillTransitionError(
        `Always-on skill instructions can total at most ${this.limits.maxAlwaysOnCharacters} characters in this scope. Shorten this skill or set another skill to on-demand first.`,
      );
    }
  }

  /** What saving `input` would do now. Throws when the save would be rejected. */
  async planSave(scope: SkillScope, input: SaveSkillInput): Promise<SavePlan> {
    const name = this.normalizeName(input.name);
    const content = normalizeSkillContent(input);
    const validation = validateSkillContent(content, this.limits);
    if (!validation.valid) throw new InvalidSkillContentError(validation.errors);
    const catalog = await this.#repository.listHeads(scope);
    const existing = catalog.heads.find((head) => head.name === name) ?? null;
    const applicationMode = input.applicationMode ?? existing?.applicationMode ?? "on-demand";
    if (applicationMode !== "always" && !isRoutingDescription(content.description)) {
      throw new InvalidSkillContentError([ROUTING_DESCRIPTION_REQUIREMENT]);
    }
    if (existing === null) {
      if (catalog.heads.length >= this.limits.maxSkills) {
        throw new InvalidSkillTransitionError(
          `This scope already has ${this.limits.maxSkills} skills, the most it can hold. Remove one first.`,
        );
      }
    }
    const activates = existing === null && validation.warnings.length === 0;
    if (activates && applicationMode === "always") {
      await this.#assertAlwaysOnCapacity(scope, catalog, name, content.markdown);
    }
    const live = liveState(existing);
    const liveRecord =
      existing?.liveVersion == null
        ? null
        : await this.#requireVersion(scope, name, existing.liveVersion);
    return {
      name,
      ...content,
      applicationMode,
      validation,
      version: (existing?.latestVersion ?? 0) + 1,
      activates,
      live: liveRecord ? { ...live, instructions: liveRecord.markdown } : live,
      revision: catalog.revision,
    };
  }

  /**
   * Saves a new immutable version. A clean first version goes live; every
   * other save is a draft that doesn't change what applies.
   */
  async save(
    scope: SkillScope,
    input: SaveSkillInput,
    options: SaveSkillOptions,
  ): Promise<SkillChange & { readonly replayed: boolean }> {
    for (let attempt = 1; ; attempt += 1) {
      const plan = await this.planSave(scope, input);
      const expectedLatest = plan.version === 1 ? null : plan.version - 1;
      try {
        const result = await this.#repository.appendVersion(scope, {
          name: plan.name,
          expectedLatest,
          expectedRevision: plan.revision,
          idempotencyKey: options.idempotencyKey,
          version: {
            description: plan.description,
            markdown: plan.markdown,
            applicationMode: plan.applicationMode,
            checksum: skillChecksum(plan.name, plan.description, plan.markdown),
            validation: plan.validation,
            savedBy: options.savedBy,
          },
          activate: plan.activates && options.draft !== true,
        });
        return {
          skill: materialize(plan.name, result.version, result.head),
          previous: { version: plan.live.version, applicationMode: plan.live.applicationMode },
          replayed: result.replayed,
        };
      } catch (error) {
        if (!(error instanceof SkillConflictError) || attempt >= SAVE_ATTEMPTS) throw error;
      }
    }
  }

  /** Every live skill in the scope, read in one batch. */
  async listLive(scope: SkillScope): Promise<StoredSkill[]> {
    return this.#liveSkills(scope, (await this.#repository.listHeads(scope)).heads);
  }

  /** One summary per skill. Versions are numbered 1, 2, 3… with no gaps. */
  async listSummaries(scope: SkillScope): Promise<SkillSummary[]> {
    const { heads } = await this.#repository.listHeads(scope);
    const shown = heads.map((head) => head.liveVersion ?? head.latestVersion);
    const [shownVersions, latestVersions] = await Promise.all([
      this.#repository.getVersions(
        scope,
        heads.map((head, index) => ({ name: head.name, version: shown[index]! })),
      ),
      this.#repository.getVersions(
        scope,
        heads.map(({ name, latestVersion }) => ({ name, version: latestVersion })),
      ),
    ]);
    return heads
      .flatMap((head, index): SkillSummary[] => {
        const shownVersion = shownVersions[index];
        if (!shownVersion) return [];
        const firstDraft = (head.liveVersion ?? 0) + 1;
        return [
          {
            name: head.name,
            description: shownVersion.description,
            status: head.liveVersion === null ? "draft" : "active",
            liveVersion: head.liveVersion,
            latestVersion: head.latestVersion,
            draftVersions: Array.from(
              { length: Math.max(0, head.latestVersion - firstDraft + 1) },
              (_, offset) => firstDraft + offset,
            ),
            warningCount: latestVersions[index]?.validation.warnings.length ?? 0,
            applicationMode:
              head.liveVersion === null ? shownVersion.applicationMode : head.applicationMode,
            updatedAt: head.updatedAt,
          },
        ];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every version, newest first. */
  async listVersions(scope: SkillScope, name: string): Promise<StoredSkill[]> {
    const head = await this.#requireHead(scope, name);
    const versions = await this.#repository.listVersions(scope, name);
    return versions
      .map((version) => materialize(name, version, head))
      .sort((a, b) => b.version - a.version);
  }

  /** One version; the latest when `version` is omitted. */
  async getVersion(scope: SkillScope, name: string, version?: number): Promise<StoredSkill> {
    const head = await this.#requireHead(scope, name);
    const target = version ?? head.latestVersion;
    return materialize(name, await this.#requireVersion(scope, name, target), head);
  }

  /** Checks that `target` can go live, in the mode it was saved with. */
  async planPublish(scope: SkillScope, name: string, target: number): Promise<HeadPlan> {
    const { catalog, head } = await this.#snapshot(scope, name);
    if (head.liveVersion === target) {
      throw new InvalidSkillTransitionError(
        `Skill "${name}" version ${target} is already live. If it is not applying, check its application mode with \`set_mode\`.`,
      );
    }
    const version = await this.#requireVersion(scope, name, target);
    if (!version.validation.valid) {
      throw new InvalidSkillTransitionError(
        `Skill "${name}" version ${target} failed validation: ${version.validation.errors.join(" ")}`,
      );
    }
    if (version.applicationMode === "always") {
      await this.#assertAlwaysOnCapacity(scope, catalog, name, version.markdown);
    } else if (!isRoutingDescription(version.description)) {
      throw new InvalidSkillContentError([ROUTING_DESCRIPTION_REQUIREMENT]);
    }
    return { head, version, revision: catalog.revision };
  }

  async #applyPublish(scope: SkillScope, name: string, plan: HeadPlan): Promise<SkillChange> {
    const updated = await this.#repository.updateHead(scope, {
      name,
      liveVersion: plan.version.version,
      applicationMode: plan.version.applicationMode,
      expectedRevision: plan.revision,
    });
    return { skill: materialize(name, plan.version, updated), previous: liveState(plan.head) };
  }

  /** Makes an exact version live, in the mode it was saved with. */
  async publish(scope: SkillScope, name: string, target: number): Promise<SkillChange> {
    return this.#retrying(async () =>
      this.#applyPublish(scope, name, await this.planPublish(scope, name, target)),
    );
  }

  /** Checks that `target` is earlier than the live version and can go live. */
  async planRollback(scope: SkillScope, name: string, target: number): Promise<HeadPlan> {
    const head = await this.#requireHead(scope, name);
    if (head.liveVersion === null) {
      throw new InvalidSkillTransitionError(`Skill "${name}" has no active version to roll back.`);
    }
    if (target >= head.liveVersion) {
      throw new InvalidSkillTransitionError(
        `Skill "${name}" cannot roll back from version ${head.liveVersion} to version ${target}. Roll back only to an earlier version; publish a later one instead.`,
      );
    }
    const plan = await this.planPublish(scope, name, target);
    if (plan.head.liveVersion !== head.liveVersion) {
      throw new SkillConflictError(`Skill "${name}" changed while rolling back.`);
    }
    return plan;
  }

  /** Makes an exact earlier version live again, in the mode it was saved with. */
  async rollback(scope: SkillScope, name: string, target: number): Promise<SkillChange> {
    return this.#retrying(async () =>
      this.#applyPublish(scope, name, await this.planRollback(scope, name, target)),
    );
  }

  /** Checks that the live version is `target` and can apply in `mode`. */
  async planSetMode(
    scope: SkillScope,
    name: string,
    target: number,
    mode: SkillApplicationMode,
  ): Promise<HeadPlan> {
    const { catalog, head } = await this.#snapshot(scope, name);
    if (head.liveVersion === null) {
      throw new InvalidSkillTransitionError(
        `Skill "${name}" has no active version. Activate a version before changing its application mode.`,
      );
    }
    if (head.liveVersion !== target) {
      throw new InvalidSkillTransitionError(
        `Skill "${name}" version ${target} is not active. The current active version is ${head.liveVersion}; review it before changing how it is applied.`,
      );
    }
    const version = await this.#requireVersion(scope, name, target);
    if (head.applicationMode !== mode) {
      if (mode === "always") {
        await this.#assertAlwaysOnCapacity(scope, catalog, name, version.markdown);
      } else if (!isRoutingDescription(version.description)) {
        throw new InvalidSkillContentError([ROUTING_DESCRIPTION_REQUIREMENT]);
      }
    }
    return { head, version, revision: catalog.revision };
  }

  /**
   * Changes how the exact live version applies. The write fails if anything in
   * the scope changed since the check, so a version published meanwhile is
   * never changed in this one's place.
   */
  async setMode(
    scope: SkillScope,
    name: string,
    target: number,
    mode: SkillApplicationMode,
  ): Promise<SkillChange> {
    return this.#retrying(async () => {
      const { head, version, revision } = await this.planSetMode(scope, name, target, mode);
      const updated =
        head.applicationMode === mode
          ? head
          : await this.#repository.updateHead(scope, {
              name,
              applicationMode: mode,
              expectedRevision: revision,
            });
      return { skill: materialize(name, version, updated), previous: liveState(head) };
    });
  }

  /** The live state of each named skill, `null` for any that don't exist. */
  async liveStates(
    scope: SkillScope,
    names: readonly string[],
  ): Promise<Array<(SkillLiveState & { readonly instructions?: string }) | null>> {
    const heads = await Promise.all(names.map((name) => this.#repository.getHead(scope, name)));
    const live = heads.flatMap((head) =>
      head?.liveVersion == null ? [] : [{ name: head.name, version: head.liveVersion }],
    );
    const records = await this.#repository.getVersions(scope, live);
    const instructions = new Map(live.map((ref, index) => [ref.name, records[index]?.markdown]));
    return heads.map((head) =>
      head === null
        ? null
        : { ...liveState(head), instructions: instructions.get(head.name) ?? undefined },
    );
  }

  /** Deletes skills and their whole version history. */
  async remove(scope: SkillScope, names: readonly string[]) {
    return this.#repository.remove(scope, [...new Set(names)]);
  }
}
