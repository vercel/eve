const KEY_REGISTRY_GLOBAL_KEY = Symbol.for("eve.context-key-registry");

type KeyRegistryGlobal = typeof globalThis & {
  [KEY_REGISTRY_GLOBAL_KEY]?: Map<string, ContextKey<unknown>>;
};

const globalKeyRegistryContainer = globalThis as KeyRegistryGlobal;

if (globalKeyRegistryContainer[KEY_REGISTRY_GLOBAL_KEY] === undefined) {
  globalKeyRegistryContainer[KEY_REGISTRY_GLOBAL_KEY] = new Map<string, ContextKey<unknown>>();
}

const keyRegistry = globalKeyRegistryContainer[KEY_REGISTRY_GLOBAL_KEY];

export interface ContextReader {
  get<T>(key: ContextKey<T>): T | undefined;
  require<T>(key: ContextKey<T>): T;
  has<T>(key: ContextKey<T>): boolean;
}

export interface ContextAccessor extends ContextReader {
  set<T>(key: ContextKey<T>, updater: T | ((current: T | undefined) => T)): T;
  ensure<T>(key: ContextKey<T>, create: () => T): T;
}

export interface ContextKeyCodec<T> {
  serialize(value: T): unknown;
  deserialize(data: unknown, ctx: ContextReader): T | Promise<T>;
}

export interface ContextKeyOptions<T> {
  readonly codec?: ContextKeyCodec<T>;
}

export class ContextKey<T> {
  readonly name: string;
  readonly codec?: ContextKeyCodec<T>;

  constructor(name: string, options: ContextKeyOptions<T> = {}) {
    this.name = name;
    this.codec = options.codec;

    const existing = keyRegistry.get(name);
    if (existing !== undefined && (existing.codec === undefined) !== (this.codec === undefined)) {
      throw new Error(
        `ContextKey name collision: "${name}" is already registered ${
          existing.codec ? "with" : "without"
        } a codec, but a key ${
          this.codec ? "with" : "without"
        } a codec is being registered under the same name. This silently breaks context serialization — use a distinct name.`,
      );
    }

    keyRegistry.set(name, this as ContextKey<unknown>);
  }
}

export function resolveKey(name: string): ContextKey<unknown> | undefined {
  return keyRegistry.get(name);
}
