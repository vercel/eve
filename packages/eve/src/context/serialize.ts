import { type AlsContext, ContextContainer } from "#context/container.js";
import { resolveKey } from "#context/key.js";
import { createLogger, logError } from "#internal/logging.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("context.serialize");

/**
 * Serializes every value in the context to a plain JSON record.
 *
 * Keys with a codec are run through `codec.serialize`; keys without one
 * are stored as-is (they must already be JSON-safe).
 */
export function serializeContext(ctx: AlsContext): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of ctx.entries()) {
    try {
      data[key.name] = key.codec ? key.codec.serialize(value) : value;
    } catch (error) {
      // Name the offending key before it surfaces as an opaque failure inside the workflow SDK.
      logError(log, "failed to serialize context key", error, { key: key.name });
      throw error;
    }
  }
  return data;
}

/**
 * Deserializes a plain JSON record into a fresh context container.
 *
 * Each entry is matched to a registered {@link ContextKey} by name.
 * Unknown entries (no registered key) are dropped with a warning.
 */
export async function deserializeContext(data: Record<string, unknown>): Promise<ContextContainer> {
  const ctx = new ContextContainer();

  const serializedBundle = data[BundleKey.name];
  if (serializedBundle !== undefined) {
    const codec = BundleKey.codec;
    if (codec === undefined) {
      throw new Error('Context key "eve.bundle" is missing a codec.');
    }
    ctx.set(BundleKey, await codec.deserialize(serializedBundle, ctx));
  }

  for (const [name, raw] of Object.entries(data)) {
    if (raw === undefined) continue;
    if (name === BundleKey.name) continue;
    const key = resolveKey(name);
    if (key === undefined) {
      // Unregistered key (e.g. renamed): dropping it silently loses data, so warn.
      log.warn("dropping unknown context key during deserialization", { key: name });
      continue;
    }
    try {
      ctx.set(key, key.codec ? await key.codec.deserialize(raw, ctx) : raw);
    } catch (error) {
      logError(log, "failed to deserialize context key", error, { key: name });
      throw error;
    }
  }
  return ctx;
}
