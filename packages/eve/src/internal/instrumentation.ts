/**
 * Shared instrumentation primitives used by both the channel projection
 * builder (`#channel/instrumentation.ts`) and the harness telemetry
 * builder (`#harness/instrumentation-runtime-context.ts`).
 *
 * Both layers resolve a user-authored projector callback into a plain
 * record and reason about the same channel-kind vocabulary. Keeping that
 * vocabulary and the defensive resolution shell in one place stops the
 * two sites from drifting (e.g. the framework-kind set growing in one
 * file but not the other).
 */
import { type Logger, formatError } from "#internal/logging.js";
import type { InstrumentationChannelKind } from "#public/channels/index.js";
import { isPlainRecord, isThenable } from "#shared/guards.js";
import { parseJsonObject } from "#shared/json.js";

/**
 * Framework-owned channel kinds that are not derived from a route file
 * path. Keep in sync with the non-`channel:<name>` keys of
 * {@link InstrumentationChannelKind} (currently every key except
 * `"unknown"`, which is the fallback rather than a real channel).
 */
const FRAMEWORK_CHANNEL_KINDS: ReadonlySet<string> = new Set(["http", "schedule", "subagent"]);

/**
 * Returns `true` when `kind` is a valid instrumentation channel kind: a
 * framework kind (`"http"`, `"schedule"`, `"subagent"`) or a
 * path-derived `channel:<name>` kind.
 */
export function isInstrumentationChannelKind(kind: string): kind is InstrumentationChannelKind {
  return kind.startsWith("channel:") || FRAMEWORK_CHANNEL_KINDS.has(kind);
}

/**
 * Narrows a raw kind string to the public {@link InstrumentationChannelKind}
 * union, falling back to `"unknown"` for anything unrecognized or absent.
 */
export function normalizeInstrumentationChannelKind(
  rawKind: string | undefined,
): InstrumentationChannelKind {
  return rawKind !== undefined && isInstrumentationChannelKind(rawKind) ? rawKind : "unknown";
}

/**
 * Invokes a user-authored instrumentation projector defensively.
 *
 * Returns the JSON object the projector produced. Returns `undefined`
 * without warning for a no-op `undefined`, or with a warning when it threw,
 * returned a `Promise`, returned an incorrect shape, or included values
 * outside eve's JSON contract. Every rejection path is warning-only so
 * instrumentation can never break the turn. Per-value shaping (for example
 * reserved-key filtering) is left to the caller, since the channel and
 * harness expose different value shapes.
 */
export function resolveInstrumentationProjection(input: {
  readonly invoke: () => unknown;
  readonly log: Logger;
  readonly source: string;
}): Record<string, unknown> | undefined {
  const { invoke, log, source } = input;

  let result: unknown;
  try {
    result = invoke();
  } catch (error) {
    log.warn("ignoring instrumentation projection after projector failure", {
      error: formatError(error),
      source,
    });
    return undefined;
  }

  if (isThenable(result)) {
    log.warn("ignoring instrumentation projection because it returned a Promise", { source });
    void Promise.resolve(result).catch((error: unknown) => {
      log.warn("ignored instrumentation projection Promise rejected", {
        error: formatError(error),
        source,
      });
    });
    return undefined;
  }

  if (result === undefined) {
    return undefined;
  }

  if (!isPlainRecord(result)) {
    log.warn("ignoring instrumentation projection because it is not a record", { source });
    return undefined;
  }

  try {
    return parseJsonObject(result);
  } catch (error) {
    log.warn("ignoring instrumentation projection because it is outside the JSON contract", {
      error: formatError(error),
      source,
    });
    return undefined;
  }
}
