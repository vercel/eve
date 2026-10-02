import { type AlsContext, ContextContainer } from "#context/container.js";
import { resolveKey } from "#context/key.js";
import { createLogger, logError } from "#internal/logging.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { mountedStateKeyName } from "#public/definitions/state.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("context.serialize");
const STATE_LAYOUT_KEY = "eve.stateLayout";
const STATE_LAYOUT_VERSION = 1;

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
  if (
    data[BundleKey.name] !== undefined ||
    Object.keys(data).some((name) => name.startsWith("eve:mount."))
  ) {
    data[STATE_LAYOUT_KEY] = STATE_LAYOUT_VERSION;
  }
  return data;
}

/**
 * Deserializes a plain JSON record into a fresh context container.
 *
 * Each entry is matched to a registered {@link ContextKey} by name.
 * Unknown entries (no registered key) are dropped with a warning.
 */
export async function deserializeContext(
  serialized: Record<string, unknown>,
): Promise<ContextContainer> {
  let data = serialized;
  const ctx = new ContextContainer();

  const serializedBundle = data[BundleKey.name];
  if (data[STATE_LAYOUT_KEY] !== undefined && data[STATE_LAYOUT_KEY] !== STATE_LAYOUT_VERSION) {
    throw new IncompatibleStateLayoutError();
  }
  if (
    data[STATE_LAYOUT_KEY] === undefined &&
    Object.keys(data).some((name) => data[name] !== undefined && name.startsWith("eve:mount."))
  ) {
    throw new IncompatibleStateLayoutError();
  }
  if (serializedBundle !== undefined) {
    const codec = BundleKey.codec;
    if (codec === undefined) {
      throw new Error('Context key "eve.bundle" is missing a codec.');
    }
    const bundle = await codec.deserialize(serializedBundle, ctx);
    if (data[STATE_LAYOUT_KEY] === undefined) data = await adoptLegacyStateLayout(data, bundle);
    ctx.set(BundleKey, bundle);
  }

  for (const [name, raw] of Object.entries(data)) {
    if (raw === undefined) continue;
    if (name === BundleKey.name || name === STATE_LAYOUT_KEY) continue;
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

/**
 * Admits a context written before mount-scoped state (eve 0.68 and earlier).
 * Extension state moves to its mount's key when exactly one mount uses its
 * package namespace. State that no mount could own was removed from this
 * deployment and is dropped as in the current layout; ambiguous state refuses.
 */
async function adoptLegacyStateLayout(
  data: Record<string, unknown>,
  bundle: CompiledBundle,
): Promise<Record<string, unknown>> {
  const manifest = await loadCompiledManifest({
    compiledArtifactsSource: bundle.compiledArtifactsSource,
  });
  const mounts = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)].flatMap(
    (node) => node.extensionMounts,
  );
  const adopted: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (name === BundleKey.name || resolveKey(name) !== undefined) {
      adopted[name] = value;
      continue;
    }
    const owners = mounts.flatMap((mount) => {
      const prefix = `${legacyPackageStateNamespace(mount.packageName)}.`;
      return name.startsWith(prefix)
        ? [mountedStateKeyName(mount.mountId, name.slice(prefix.length))]
        : [];
    });
    if (owners.length === 0) {
      adopted[name] = value;
      continue;
    }
    const [mounted] = owners;
    if (
      owners.length !== 1 ||
      mounted === undefined ||
      resolveKey(mounted) === undefined ||
      data[mounted] !== undefined
    ) {
      throw new IncompatibleStateLayoutError(name);
    }
    adopted[mounted] = value;
  }
  return adopted;
}

/** The `defineState` prefix extensions used before state was scoped to mounts. */
function legacyPackageStateNamespace(packageName: string): string {
  return (
    packageName
      .replace(/^@/, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "extension"
  );
}

/** A context whose saved state this deployment cannot place; retrying never changes the answer. */
export class IncompatibleStateLayoutError extends Error {
  constructor(key?: string) {
    super(
      `Incompatible context state layout${key === undefined ? "" : ` for key "${key}"`}. Restore this session with its original deployment or start a new session; state with no unambiguous owner in this deployment cannot be carried forward.`,
    );
    this.name = "IncompatibleStateLayoutError";
  }
}
