import { type Logger, formatError } from "#internal/logging.js";
import { isPlainRecord, isThenable } from "#shared/guards.js";
import { parseJsonObject } from "#shared/json.js";
export {
  isInstrumentationChannelKind,
  normalizeInstrumentationChannelKind,
} from "#shared/instrumentation-channel-kind.js";

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
