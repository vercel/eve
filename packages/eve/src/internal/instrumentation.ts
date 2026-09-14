/**
 * Shared instrumentation primitives used by both the channel projection
 * builder (`#channel/instrumentation.ts`) and the harness telemetry
 * builder (`#instrumentation/runtime-context.ts`).
 *
 * Both layers resolve a user-authored projector callback into a plain
 * record and reason about the same channel-kind vocabulary. Keeping that
 * vocabulary and the defensive resolution shell in one place stops the
 * two sites from drifting (e.g. the framework-kind set growing in one
 * file but not the other).
 */
import { type Logger, formatError } from "#internal/logging.js";
import { isPlainRecord, isThenable } from "#shared/guards.js";
import { parseJsonObject } from "#shared/json.js";
export {
  isInstrumentationChannelKind,
  normalizeInstrumentationChannelKind,
} from "#shared/instrumentation-channel-kind.js";

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
