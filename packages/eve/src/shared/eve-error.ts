const LINEAGE = Symbol.for("eve.error.lineage");

/**
 * Base class of errors eve throws to callers. Every eve error has a stable snake_case `code`.
 *
 * Narrow with the static `is()` of the class you expect, such as `ClientError.is(error)`.
 * Unlike `instanceof`, it recognizes errors created by another copy of eve, for example when a
 * framework bundles eve separately from your application code.
 */
export class EveError extends Error {
  /**
   * Stable class name that `is()` matches and the instance `name` reports. Minifiers rename
   * constructors, so every subclass must declare its own; the constructor throws otherwise.
   */
  static readonly errorName: string = "EveError";

  /** Stable snake_case error code. */
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    if (new.target !== EveError && !Object.hasOwn(new.target, "errorName")) {
      throw new TypeError(`${new.target.name} must declare its own static errorName.`);
    }
    this.name = new.target.errorName;
    this.code = code;
    const lineage = [new.target.errorName];
    for (let type = new.target; type !== EveError;) {
      type = Object.getPrototypeOf(type) as typeof EveError;
      lineage.push(type.errorName);
    }
    markErrorLineage(this, lineage);
  }

  /** Whether `error` is an eve error of this class or a subclass, from any copy of eve. */
  static is<T extends EveError>(
    this: { readonly errorName: string; readonly prototype: T },
    error: unknown,
  ): error is T {
    return hasErrorLineage(error, this.errorName);
  }
}

export function markErrorLineage(error: Error, lineage: readonly string[]): void {
  Object.defineProperty(error, LINEAGE, { value: Object.freeze([...lineage]) });
}

export function hasErrorLineage(error: unknown, errorName: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const lineage: unknown = Reflect.get(error, LINEAGE);
  return Array.isArray(lineage) && lineage.includes(errorName);
}
