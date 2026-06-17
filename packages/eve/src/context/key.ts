/**
 * Process-wide registry mapping key names to instances. Populated automatically
 * by the {@link ContextKey} constructor so `deserializeContext` can resolve
 * string names back to typed keys without an explicit list.
 *
 * Rooted on `globalThis` so Nitro-inlined eve and disk-imported eve share one
 * registry. Each Nitro workflow chunk can carry its own evaluated copy of
 * `key.ts`; without a shared registry, a key registered by one chunk is
 * invisible to `resolveKey()` in another, and `serializeContext` /
 * `deserializeContext` silently drop entries at step boundaries.
 *
 * See `context/container.ts` (`EVE_CONTEXT_STORAGE_KEY`) and
 * `runtime/sessions/runtime-session.ts` (`RUNTIME_SESSION_STORAGE_GLOBAL_KEY`)
 * for the established pattern.
 */
const KEY_REGISTRY_GLOBAL_KEY = Symbol.for("eve.context-key-registry");

type KeyRegistryGlobal = typeof globalThis & {
  [KEY_REGISTRY_GLOBAL_KEY]?: Map<string, ContextKey<unknown>>;
};

const globalKeyRegistryContainer = globalThis as KeyRegistryGlobal;

if (globalKeyRegistryContainer[KEY_REGISTRY_GLOBAL_KEY] === undefined) {
  globalKeyRegistryContainer[KEY_REGISTRY_GLOBAL_KEY] = new Map<string, ContextKey<unknown>>();
}

const keyRegistry = globalKeyRegistryContainer[KEY_REGISTRY_GLOBAL_KEY];

/**
 * Read-only view over the active context.
 *
 * Used by context providers and codec deserialization to read values
 * without mutating durable context.
 */
export interface ContextReader {
  get<T>(key: ContextKey<T>): T | undefined;
  require<T>(key: ContextKey<T>): T;
  has<T>(key: ContextKey<T>): boolean;
}

/**
 * Read/write view over the active context.
 *
 * Extends {@link ContextReader} with durable write operations. This is
 * the narrow contract shared by {@link AlsContext} and the channel-facing
 * `ContextAccessor`.
 */
export interface ContextAccessor extends ContextReader {
  set<T>(key: ContextKey<T>, updater: T | ((current: T | undefined) => T)): T;
  ensure<T>(key: ContextKey<T>, create: () => T): T;
}

/**
 * Serialization hooks for one context key.
 *
 * `deserialize` receives the already-hydrated durable context so codecs can
 * depend on earlier durable keys such as the compiled runtime bundle.
 */
export interface ContextKeyCodec<T> {
  serialize(value: T): unknown;
  deserialize(data: unknown, ctx: ContextReader): T | Promise<T>;
}

export interface ContextKeyOptions<T> {
  readonly codec?: ContextKeyCodec<T>;
}

/**
 * Typed key that identifies a named context slot.
 */
export class ContextKey<T> {
  readonly name: string;
  readonly codec?: ContextKeyCodec<T>;

  constructor(name: string, options: ContextKeyOptions<T> = {}) {
    this.name = name;
    this.codec = options.codec;

    // The registry is last-write-wins and is re-populated per Nitro chunk, so a
    // key legitimately re-registers under the same name. But a collision where
    // one key carries a (de)serialization codec and the other does not silently
    // corrupts serialization at step boundaries: the codec-less key wins the
    // registry, and the value is then stored/loaded raw instead of through the
    // codec. Surface that case loudly instead of letting it corrupt sessions.
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

/**
 * Looks up a registered key by name. Returns `undefined` for unknown names.
 */
export function resolveKey(name: string): ContextKey<unknown> | undefined {
  return keyRegistry.get(name);
}
