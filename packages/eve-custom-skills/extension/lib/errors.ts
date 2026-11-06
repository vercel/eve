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

export class InvalidSkillNameError extends SkillLifecycleError {}

export class InvalidSkillContentError extends SkillLifecycleError {
  constructor(errors: readonly string[]) {
    super(errors.join(" "));
  }
}

export class SkillNotFoundError extends SkillLifecycleError {
  constructor(id: string) {
    super(`No skill named "${id}" was found in this scope.`);
  }
}

export class SkillVersionNotFoundError extends SkillLifecycleError {
  constructor(name: string, version: number) {
    super(`Skill "${name}" has no version ${version}.`);
  }
}

export class InvalidSkillTransitionError extends SkillLifecycleError {}

/**
 * A write lost a race: the skill's latest version is no longer the one the
 * caller expected, or a new skill's id is already taken.
 */
export class SkillConflictError extends SkillLifecycleError {}
