/** Base class for lifecycle errors whose message the model can act on. */
export class SkillLifecycleError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class SkillStorageNotConfiguredError extends SkillLifecycleError {
  constructor() {
    super(
      "Custom skill storage is not configured. Set BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID with Vercel OIDC), or pass `storage` or `repository` to the extension mount.",
    );
  }
}

export class SkillScopeUnavailableError extends SkillLifecycleError {}

/** A stored document doesn't parse; the repository logs which one. */
export class SkillStorageCorruptError extends SkillLifecycleError {
  constructor() {
    super(
      "A stored custom skill document is unreadable, so skills in this scope can't change until an administrator repairs it.",
    );
  }
}

export class InvalidSkillNameError extends SkillLifecycleError {}

export class InvalidSkillContentError extends SkillLifecycleError {
  constructor(errors: readonly string[]) {
    super(errors.join(" "));
  }
}

/** The skill doesn't exist in the scope. Repositories throw it from `updateHead`. */
export class SkillNotFoundError extends SkillLifecycleError {
  constructor(name: string) {
    super(`No skill named "${name}" was found in this scope.`);
  }
}

export class SkillVersionNotFoundError extends SkillLifecycleError {
  constructor(name: string, version: number) {
    super(`Skill "${name}" has no version ${version}.`);
  }
}

export class InvalidSkillTransitionError extends SkillLifecycleError {}

/** The approval rule refused the change, or the scope is read-only. */
export class SkillChangeRefusedError extends SkillLifecycleError {}

/**
 * A write lost a race: the skill's latest version is no longer the one the
 * caller expected, or a new skill's name is already taken. Repositories throw
 * it from `appendVersion`; the lifecycle retries saves that didn't pin a version.
 */
export class SkillConflictError extends SkillLifecycleError {}
