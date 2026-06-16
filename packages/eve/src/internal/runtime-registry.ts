/**
 * Source location for one entry registered with a {@link RuntimeRegistry}.
 *
 * Carried on {@link RuntimeRegistryError} so callers (CLI diagnostics,
 * IDE integrations) can point at the file that introduced the conflict.
 */
export interface RuntimeRegistryEntryLocation {
  readonly logicalPath?: string;
  readonly sourceId?: string;
}

/**
 * Error raised when a runtime-owned subsystem rejects an entry — for
 * example a duplicate authored sandbox name, a tool name reserved by the
 * framework, or a subagent whose node id is already taken.
 *
 * The `registry` field identifies which subsystem produced the error
 * (`"sandbox"`, `"tool"`, `"subagent"`, …) so consumers can branch on
 * one error class instead of `instanceof`-ing one per primitive.
 */
export class RuntimeRegistryError extends Error {
  readonly registry: string;
  readonly entryName?: string;
  readonly logicalPath?: string;
  readonly sourceId?: string;

  constructor(
    registry: string,
    message: string,
    context: RuntimeRegistryEntryLocation & { readonly entryName?: string } = {},
  ) {
    super(message);
    this.name = "RuntimeRegistryError";
    this.registry = registry;
    if (context.entryName !== undefined) {
      this.entryName = context.entryName;
    }
    if (context.logicalPath !== undefined) {
      this.logicalPath = context.logicalPath;
    }
    if (context.sourceId !== undefined) {
      this.sourceId = context.sourceId;
    }
  }
}

/**
 * Options accepted by {@link RuntimeRegistry.register}.
 */
interface RuntimeRegistryRegisterOptions {
  /** Source location attached to the error if registration fails. */
  readonly location?: RuntimeRegistryEntryLocation;
  /** Override the default "duplicate name" error message. */
  readonly duplicateMessage?: string;
  /** Override the default "name reserved" error message. */
  readonly reservedMessage?: string;
}

/**
 * Map-backed primitive for runtime-owned subsystems that index entries
 * by unique name and need to surface a consistent error shape on
 * collision.
 *
 * The optional `reserved` set lets a registry detect collisions across
 * multiple registration passes — for example the tool registry seeds
 * reserved framework tool names so authored tools cannot shadow them.
 * Once an entry is registered its name is automatically added to the
 * reserved set.
 */
export class RuntimeRegistry<TEntry> {
  private readonly registry: string;
  private readonly _entries = new Map<string, TEntry>();
  private readonly _reserved: Set<string>;

  constructor(registry: string, reserved: Iterable<string> = []) {
    this.registry = registry;
    this._reserved = new Set(reserved);
  }

  get size(): number {
    return this._entries.size;
  }

  has(name: string): boolean {
    return this._entries.has(name);
  }

  get(name: string): TEntry | null {
    return this._entries.get(name) ?? null;
  }

  /**
   * Returns the underlying map. Callers must treat the returned value
   * as read-only.
   */
  asMap(): ReadonlyMap<string, TEntry> {
    return this._entries;
  }

  /**
   * Adds an entry to the registry. Throws {@link RuntimeRegistryError}
   * if `name` is already registered or already reserved by a previous
   * registration pass.
   */
  register(name: string, entry: TEntry, options: RuntimeRegistryRegisterOptions = {}): void {
    if (this._entries.has(name)) {
      throw new RuntimeRegistryError(
        this.registry,
        options.duplicateMessage ?? `Duplicate ${this.registry} name "${name}".`,
        { ...options.location, entryName: name },
      );
    }

    if (this._reserved.has(name)) {
      throw new RuntimeRegistryError(
        this.registry,
        options.reservedMessage ??
          `${capitalize(this.registry)} "${name}" collides with another runtime-visible name.`,
        { ...options.location, entryName: name },
      );
    }

    this._entries.set(name, entry);
    this._reserved.add(name);
  }

  /**
   * Adds or replaces an entry without uniqueness or reservation checks.
   * Use for framework-owned defaults that the caller has already
   * validated.
   */
  set(name: string, entry: TEntry): void {
    this._entries.set(name, entry);
    this._reserved.add(name);
  }
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}
