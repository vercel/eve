import { type AlsContext, ContextContainer } from "#context/container.js";
import { resolveKey } from "#context/key.js";
import { createLogger, logError } from "#internal/logging.js";
import { loadCompiledManifest } from "#platform/compiled-agents.js";
import { mountedStateKeyName } from "#public/definitions/state.js";
import { BUNDLE_CONTEXT_KEY_NAME, SESSION_AGENT_CONTEXT_KEY_NAME } from "#context/key-names.js";
import {
  type CompiledBundle,
  readAgentReference,
  resolveSessionAgent,
  SessionAgentKey,
  writeAgentReference,
} from "#runtime/sessions/runtime-context-keys.js";
import type { SessionAgent } from "#runtime/sessions/session-agent.js";

const log = createLogger("context.serialize");
const STATE_LAYOUT_KEY = "eve.stateLayout";
const STATE_LAYOUT_VERSION = 1;
/** The fields a session's agent reference is stored under, one per kind. */
const AGENT_FIELDS: ReadonlySet<string> = new Set([
  BUNDLE_CONTEXT_KEY_NAME,
  SESSION_AGENT_CONTEXT_KEY_NAME,
]);

/**
 * Serializes every value in the context to a plain JSON record.
 *
 * Keys with a codec are run through `codec.serialize`; keys without one
 * are stored as-is (they must already be JSON-safe). The session's agent is
 * stored as its reference, under the field its kind names (`eve.bundle` for a
 * compiled agent), where its key stands.
 */
export function serializeContext(ctx: AlsContext): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  let holdsAgent = false;
  for (const [key, value] of ctx.entries()) {
    try {
      // By name: each Nitro chunk can construct its own copy of the key.
      if (key.name === SessionAgentKey.name) {
        const [name, reference] = writeAgentReference((value as SessionAgent).reference);
        data[name] = reference;
        holdsAgent = true;
        continue;
      }
      data[key.name] = key.codec ? key.codec.serialize(value) : value;
    } catch (error) {
      // Name the offending key before it surfaces as an opaque failure inside the workflow SDK.
      logError(log, "failed to serialize context key", error, { key: key.name });
      throw error;
    }
  }
  if (holdsAgent || Object.keys(data).some((name) => name.startsWith("eve:mount."))) {
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

  if (data[STATE_LAYOUT_KEY] !== undefined && data[STATE_LAYOUT_KEY] !== STATE_LAYOUT_VERSION) {
    throw new IncompatibleStateLayoutError();
  }
  if (
    data[STATE_LAYOUT_KEY] === undefined &&
    Object.keys(data).some((name) => data[name] !== undefined && name.startsWith("eve:mount."))
  ) {
    throw new IncompatibleStateLayoutError();
  }
  // The agent first: the channel rehydrates from it.
  const reference = readAgentReference(data);
  if (reference !== undefined) {
    const agent = await resolveSessionAgent(reference);
    if (agent.compiled !== undefined && data[STATE_LAYOUT_KEY] === undefined) {
      data = await adoptLegacyStateLayout(data, agent.compiled);
    }
    ctx.set(SessionAgentKey, agent);
  }

  for (const [name, raw] of Object.entries(data)) {
    if (raw === undefined) continue;
    if (AGENT_FIELDS.has(name) || name === STATE_LAYOUT_KEY) continue;
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
 * Extension state moves to the one mount that still defines it. Authored state
 * nothing defines was removed, so the loader drops it as in the current layout.
 * State that several mounts define refuses rather than guessing an owner.
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
    if (AGENT_FIELDS.has(name) || resolveKey(name) !== undefined) {
      adopted[name] = value;
      continue;
    }
    const owners = mounts.flatMap((mount) => {
      const prefix = `${legacyPackageStateNamespace(mount.packageName)}.`;
      if (!name.startsWith(prefix)) return [];
      const mounted = mountedStateKeyName(mount.mountId, name.slice(prefix.length));
      return resolveKey(mounted) === undefined ? [] : [mounted];
    });
    // Authored state cannot use `eve.`, so an unknown framework key means a
    // checkpoint migration missed it.
    if (owners.length > 1 || (owners.length === 0 && name.startsWith("eve."))) {
      throw new IncompatibleStateLayoutError(name);
    }
    adopted[owners[0] ?? name] = value;
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
      `Incompatible context state layout${key === undefined ? "" : ` for key "${key}"`}. This deployment cannot read the saved state. Continue this session on its original deployment or start a new session.`,
    );
    this.name = "IncompatibleStateLayoutError";
  }
}
