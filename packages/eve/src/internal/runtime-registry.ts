export interface RuntimeRegistryEntryLocation {
  readonly logicalPath?: string;
  readonly sourceId?: string;
}

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

interface RuntimeRegistryRegisterOptions {
  readonly location?: RuntimeRegistryEntryLocation;
  readonly duplicateMessage?: string;
  readonly reservedMessage?: string;
}

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

  asMap(): ReadonlyMap<string, TEntry> {
    return this._entries;
  }

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

  set(name: string, entry: TEntry): void {
    this._entries.set(name, entry);
    this._reserved.add(name);
  }
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}
