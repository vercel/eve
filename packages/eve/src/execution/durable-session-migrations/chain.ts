/**
 * Generic version-walking migration framework for versioned durable
 * wire shapes. Each migration steps a value one version forward; the
 * runner chains them so a value written at any historic version can
 * be read at the current one.
 */

/**
 * One migration step in a version chain. `to` MUST equal `from + 1`
 * and `migrate` MUST stamp the returned value's `version` field with
 * `to`; the runner verifies both.
 */
export interface VersionMigration {
  readonly from: number;
  readonly to: number;
  migrate: (prior: unknown) => { readonly version: number };
}

/**
 * Walks `value` through `migrations` until its `version` matches
 * `targetVersion`. Throws on missing migrations, malformed steps, or
 * a value newer than the runner supports.
 */
export function runMigrationChain<TOut extends { readonly version: number }>(input: {
  readonly value: unknown;
  readonly migrations: readonly VersionMigration[];
  readonly targetVersion: number;
  readonly label: string;
  /**
   * Version to read a wire value as when it carries no `version` field —
   * for shapes that predate versioning ("version 0"). Omit to require an
   * explicit numeric `version` (the default). A present but non-numeric
   * `version` is always malformed, opt-in or not.
   */
  readonly initialVersion?: number;
}): TOut {
  if (typeof input.value !== "object" || input.value === null) {
    throw new Error(`${input.label}: value has no numeric "version" field.`);
  }
  const declaredVersion = (input.value as { readonly version?: unknown }).version;
  let current: { readonly version: number };
  if (typeof declaredVersion === "number") {
    current = input.value as { readonly version: number };
  } else if (!("version" in input.value) && input.initialVersion !== undefined) {
    current = { ...input.value, version: input.initialVersion };
  } else {
    throw new Error(`${input.label}: value has no numeric "version" field.`);
  }
  const minVersion = input.initialVersion ?? 1;
  if (!Number.isInteger(current.version) || current.version < minVersion) {
    throw new Error(`${input.label}: version ${current.version} is not a positive integer.`);
  }
  if (current.version > input.targetVersion) {
    throw new Error(
      `${input.label}: encountered version ${current.version}, which is newer than the supported version ${input.targetVersion}. ` +
        `This usually indicates the wire was written by a newer eve deployment than the one reading it.`,
    );
  }
  while (current.version < input.targetVersion) {
    const migration = input.migrations.find((m) => m.from === current.version);
    if (!migration) {
      throw new Error(
        `${input.label}: no migration registered for version ${current.version} → ${current.version + 1}.`,
      );
    }
    if (migration.to !== migration.from + 1) {
      throw new Error(
        `${input.label}: migration ${migration.from} → ${migration.to} must step exactly one version at a time.`,
      );
    }
    const next = migration.migrate(current);
    if (next.version !== migration.to) {
      throw new Error(
        `${input.label}: migration ${migration.from} → ${migration.to} produced a value with version ${next.version}.`,
      );
    }
    current = next;
  }
  return current as TOut;
}
