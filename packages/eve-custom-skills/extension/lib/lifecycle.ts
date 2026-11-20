import { randomUUID } from "node:crypto";

import {
  InvalidSkillTransitionError,
  SkillConflictError,
  SkillNotFoundError,
  SkillVersionNotFoundError,
} from "./errors.ts";
import type { SkillCatalog, SkillHead, SkillRepository, SkillVersionRecord } from "./repository.ts";
import type {
  SkillApplicationMode,
  SkillAuthor,
  SkillRef,
  SkillLiveState,
  SkillScope,
  SkillSummary,
  SkillValidation,
  SkillValidator,
  SkillVersionStatus,
  StoredSkill,
} from "./types.ts";
import {
  DEFAULT_LIMITS,
  defaultSkillValidator,
  normalizeSkillContent,
  normalizeSkillName,
  skillChecksum,
  validateSkill,
  type SkillLimits,
} from "./validation.ts";

const SAVE_ATTEMPTS = 5;

export interface SaveSkillInput {
  readonly name: string;
  readonly description: string;
  readonly markdown: string;
  readonly applicationMode?: SkillApplicationMode;
}

export interface SavePlan {
  readonly id: string | null;
  readonly name: string;
  readonly description: string;
  readonly markdown: string;
  readonly applicationMode: SkillApplicationMode;
  readonly validation: SkillValidation;
  readonly version: number;
  readonly activates: boolean;
  readonly live: SkillLiveState & { readonly instructions?: string };
  readonly revision: string | null;
}

export interface HeadPlan {
  readonly head: SkillHead;
  readonly version: SkillVersionRecord;
  readonly revision: string | null;
}

export interface SaveSkillOptions {
  readonly savedBy: SkillAuthor;
  readonly idempotencyKey?: string;
  readonly draft?: boolean;
}

export interface SkillChange {
  readonly skill: StoredSkill;
  readonly previous: SkillLiveState;
}

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

function materialize(version: SkillVersionRecord, head: SkillHead): StoredSkill {
  const live = version.version === head.liveVersion;
  return {
    id: head.id,
    name: head.name,
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

export class SkillLifecycle {
  readonly #repository: SkillRepository;
  readonly #validator: SkillValidator;
  readonly limits: SkillLimits;

  constructor(options: {
    repository: SkillRepository;
    limits?: Partial<SkillLimits>;
    validator?: SkillValidator;
  }) {
    this.#repository = options.repository;
    this.#validator = options.validator ?? defaultSkillValidator;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  #validate(
    action: "save" | "publish" | "set_mode",
    scope: SkillScope,
    input: {
      name: string;
      description: string;
      markdown: string;
      applicationMode: SkillApplicationMode;
    },
  ): Promise<SkillValidation> {
    return validateSkill(
      {
        action,
        scope,
        name: input.name,
        description: input.description,
        instructions: input.markdown,
        applicationMode: input.applicationMode,
      },
      this.limits,
      this.#validator,
    );
  }

  normalizeName(raw: string): string {
    return normalizeSkillName(raw, this.limits.maxNameLength);
  }

  async #requireHead(scope: SkillScope, name: string): Promise<SkillHead> {
    const head = await this.#repository.getHead(scope, name);
    if (!head) throw new SkillNotFoundError(name);
    return head;
  }

  async #snapshot(
    scope: SkillScope,
    name: string,
  ): Promise<{ catalog: SkillCatalog; head: SkillHead }> {
    const catalog = await this.#repository.listHeads(scope);
    const head = catalog.heads.find((candidate) => candidate.name === name);
    if (!head) throw new SkillNotFoundError(name);
    return { catalog, head };
  }

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
    head: SkillHead,
    version: number,
  ): Promise<SkillVersionRecord> {
    const [record] = await this.#repository.getVersions(scope, [{ id: head.id, version }]);
    if (!record) throw new SkillVersionNotFoundError(head.name, version);
    return record;
  }

  async #liveSkills(scope: SkillScope, heads: readonly SkillHead[]): Promise<StoredSkill[]> {
    const live = heads.filter(
      (head): head is SkillHead & { liveVersion: number } => head.liveVersion !== null,
    );
    const versions = await this.#repository.getVersions(
      scope,
      live.map(({ id, liveVersion }) => ({ id, version: liveVersion })),
    );
    return live
      .flatMap((head, index) => {
        const version = versions[index];
        if (version) return [materialize(version, head)];
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

  async planSave(scope: SkillScope, input: SaveSkillInput): Promise<SavePlan> {
    const name = this.normalizeName(input.name);
    const content = normalizeSkillContent(input);
    const catalog = await this.#repository.listHeads(scope);
    const existing = catalog.heads.find((head) => head.name === name) ?? null;
    const applicationMode = input.applicationMode ?? existing?.applicationMode ?? "on-demand";
    const validation = await this.#validate("save", scope, { name, ...content, applicationMode });
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
        : await this.#requireVersion(scope, existing, existing.liveVersion);
    return {
      id: existing?.id ?? null,
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

  async save(
    scope: SkillScope,
    input: SaveSkillInput,
    options: SaveSkillOptions,
  ): Promise<SkillChange & { readonly replayed: boolean }> {
    return this.#retrying(async () =>
      this.applySave(scope, await this.planSave(scope, input), options),
    );
  }

  async applySave(
    scope: SkillScope,
    plan: SavePlan,
    options: SaveSkillOptions,
  ): Promise<SkillChange & { readonly replayed: boolean }> {
    const result = await this.#repository.appendVersion(scope, {
      id: plan.id ?? randomUUID(),
      name: plan.name,
      expectedLatest: plan.version === 1 ? null : plan.version - 1,
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
      skill: materialize(result.version, result.head),
      previous: { version: plan.live.version, applicationMode: plan.live.applicationMode },
      replayed: result.replayed,
    };
  }

  async listLive(scope: SkillScope): Promise<StoredSkill[]> {
    return this.#liveSkills(scope, (await this.#repository.listHeads(scope)).heads);
  }

  async listSummaries(scope: SkillScope): Promise<SkillSummary[]> {
    const { heads } = await this.#repository.listHeads(scope);
    const shown = heads.map((head) => head.liveVersion ?? head.latestVersion);
    const [shownVersions, latestVersions] = await Promise.all([
      this.#repository.getVersions(
        scope,
        heads.map((head, index) => ({ id: head.id, version: shown[index]! })),
      ),
      this.#repository.getVersions(
        scope,
        heads.map(({ id, latestVersion }) => ({ id, version: latestVersion })),
      ),
    ]);
    return heads
      .flatMap((head, index): SkillSummary[] => {
        const shownVersion = shownVersions[index];
        if (!shownVersion) return [];
        const firstDraft = (head.liveVersion ?? 0) + 1;
        return [
          {
            id: head.id,
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

  async listVersions(scope: SkillScope, name: string): Promise<StoredSkill[]> {
    const head = await this.#requireHead(scope, name);
    const versions = await this.#repository.listVersions(scope, head.id);
    return versions
      .map((version) => materialize(version, head))
      .sort((a, b) => b.version - a.version);
  }

  async getVersion(scope: SkillScope, name: string, version?: number): Promise<StoredSkill> {
    const head = await this.#requireHead(scope, name);
    const target = version ?? head.latestVersion;
    return materialize(await this.#requireVersion(scope, head, target), head);
  }

  async planPublish(scope: SkillScope, name: string, target: number): Promise<HeadPlan> {
    const { catalog, head } = await this.#snapshot(scope, name);
    if (head.liveVersion === target) {
      throw new InvalidSkillTransitionError(
        `Skill "${name}" version ${target} is already live. If it is not applying, check its application mode with \`set_mode\`.`,
      );
    }
    const version = await this.#requireVersion(scope, head, target);
    if (!version.validation.valid) {
      throw new InvalidSkillTransitionError(
        `Skill "${name}" version ${target} failed validation: ${version.validation.errors.join(" ")}`,
      );
    }
    await this.#validate("publish", scope, { name, ...version });
    if (version.applicationMode === "always") {
      await this.#assertAlwaysOnCapacity(scope, catalog, name, version.markdown);
    }
    return { head, version, revision: catalog.revision };
  }

  async applyPublish(scope: SkillScope, plan: HeadPlan): Promise<SkillChange> {
    const updated = await this.#repository.updateHead(scope, {
      id: plan.head.id,
      liveVersion: plan.version.version,
      applicationMode: plan.version.applicationMode,
      expectedRevision: plan.revision,
    });
    return { skill: materialize(plan.version, updated), previous: liveState(plan.head) };
  }

  async publish(scope: SkillScope, name: string, target: number): Promise<SkillChange> {
    return this.#retrying(async () =>
      this.applyPublish(scope, await this.planPublish(scope, name, target)),
    );
  }

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
    const version = await this.#requireVersion(scope, head, target);
    if (head.applicationMode !== mode) {
      await this.#validate("set_mode", scope, { name, ...version, applicationMode: mode });
      if (mode === "always") {
        await this.#assertAlwaysOnCapacity(scope, catalog, name, version.markdown);
      }
    }
    return { head, version, revision: catalog.revision };
  }

  async setMode(
    scope: SkillScope,
    name: string,
    target: number,
    mode: SkillApplicationMode,
  ): Promise<SkillChange> {
    return this.#retrying(async () =>
      this.applySetMode(scope, await this.planSetMode(scope, name, target, mode), mode),
    );
  }

  async applySetMode(
    scope: SkillScope,
    plan: HeadPlan,
    mode: SkillApplicationMode,
  ): Promise<SkillChange> {
    const { head, version, revision } = plan;
    if (head.applicationMode === mode) {
      const current = await this.#repository.listHeads(scope);
      if (current.revision !== revision) {
        throw new SkillConflictError(
          "The skills in this scope changed while this change was checked. Try again.",
        );
      }
      return { skill: materialize(version, head), previous: liveState(head) };
    }
    const updated = await this.#repository.updateHead(scope, {
      id: head.id,
      applicationMode: mode,
      expectedRevision: revision,
    });
    return { skill: materialize(version, updated), previous: liveState(head) };
  }

  async liveStates(
    scope: SkillScope,
    names: readonly string[],
  ): Promise<
    Array<(SkillLiveState & { readonly id: string; readonly instructions?: string }) | null>
  > {
    const { heads: all } = await this.#repository.listHeads(scope);
    const heads = names.map((name) => all.find((head) => head.name === name) ?? null);
    const live = heads.flatMap((head) =>
      head?.liveVersion == null ? [] : [{ id: head.id, version: head.liveVersion }],
    );
    const records = await this.#repository.getVersions(scope, live);
    const instructions = new Map(live.map((ref, index) => [ref.id, records[index]?.markdown]));
    return heads.map((head) =>
      head === null
        ? null
        : { id: head.id, ...liveState(head), instructions: instructions.get(head.id) ?? undefined },
    );
  }

  async remove(
    scope: SkillScope,
    skills: readonly SkillRef[],
  ): Promise<{ removed: SkillRef[]; notFound: SkillRef[] }> {
    const result = await this.#repository.remove(scope, [...new Set(skills.map(({ id }) => id))]);
    const removed = new Set(result.removed);
    return {
      removed: skills.filter(({ id }) => removed.has(id)),
      notFound: skills.filter(({ id }) => !removed.has(id)),
    };
  }
}
