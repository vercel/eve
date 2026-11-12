import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("channel.events");

const COMPOSITION = Symbol.for("eve.channel-event-composition");

type AnyHandler = (...args: any[]) => void | Promise<void>;

/** Where a handler runs relative to a built-in channel's default handler for the same event. */
export type ChannelEventCompositionMode = "before" | "after" | "replace";

/** A handler tagged with how it composes with the built-in default. Build one with {@link beforeDefault}, {@link afterDefault} or {@link replaceDefault}. */
export interface ChannelEventComposition<H extends AnyHandler = AnyHandler> {
  readonly [COMPOSITION]: ChannelEventCompositionMode;
  readonly handler: H;
}

/**
 * One entry of a built-in channel's `events` map: a composition, a list of them, or a plain
 * handler. A plain handler on an event with a built-in default replaces it and logs a
 * deprecation warning; state that with {@link replaceDefault} instead.
 */
export type ComposableChannelEvent<H extends AnyHandler> =
  | H
  | ChannelEventComposition<H>
  | readonly ChannelEventComposition<H>[];

/** The `events` config of a built-in channel whose handler map is `E`. */
export type ComposableChannelEvents<E> = {
  readonly [K in keyof E]?: ComposableChannelEvent<Extract<NonNullable<E[K]>, AnyHandler>>;
};

/** Runs `handler` before the channel's default. Its failure is logged and doesn't stop the default. */
export function beforeDefault<H extends AnyHandler>(handler: H): ChannelEventComposition<H> {
  return { [COMPOSITION]: "before", handler };
}

/** Runs `handler` after the channel's default. Its failure is logged; the default already ran. */
export function afterDefault<H extends AnyHandler>(handler: H): ChannelEventComposition<H> {
  return { [COMPOSITION]: "after", handler };
}

/** Runs `handler` instead of the channel's default, dropping every side effect the default owns. */
export function replaceDefault<H extends AnyHandler>(handler: H): ChannelEventComposition<H> {
  return { [COMPOSITION]: "replace", handler };
}

function isComposition(value: unknown): value is ChannelEventComposition {
  return typeof value === "object" && value !== null && COMPOSITION in value;
}

/**
 * Merges a built-in channel's default handlers with the author's `events` config. Per event:
 * `before` handlers run in order, then the default (or the one `replace` handler), then `after`
 * handlers in order. A `before` or `after` failure is logged and the rest still run; a failure
 * of the default or of a replacement propagates as it does without composition.
 */
export function composeChannelEvents<E extends object>(
  channel: string,
  defaults: E,
  events: ComposableChannelEvents<E> | undefined,
): E {
  const merged: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const [key, value] of Object.entries(events ?? {})) {
    if (value === undefined) continue;
    const fallback = (defaults as Record<string, AnyHandler | undefined>)[key];
    if (typeof value === "function") {
      if (fallback !== undefined) {
        log.warn(
          `${channel} events["${key}"] replaces the built-in handler. Wrap it in replaceDefault() to keep replacing it, or beforeDefault()/afterDefault() to keep the built-in behavior.`,
        );
      }
      merged[key] = value;
      continue;
    }
    const entries = (Array.isArray(value) ? value : [value]) as unknown[];
    if (!entries.every(isComposition)) {
      throw new Error(
        `${channel} events["${key}"] must be a handler or beforeDefault(), afterDefault() or replaceDefault() entries.`,
      );
    }
    merged[key] = composeHandler(channel, key, fallback, entries);
  }
  return merged as E;
}

function composeHandler(
  channel: string,
  key: string,
  fallback: AnyHandler | undefined,
  entries: readonly ChannelEventComposition[],
): AnyHandler {
  const replacements = entries.filter((entry) => entry[COMPOSITION] === "replace");
  if (replacements.length > 1) {
    throw new Error(`${channel} events["${key}"] has more than one replaceDefault() handler.`);
  }
  const core = replacements[0]?.handler ?? fallback;
  const before = entries.filter((entry) => entry[COMPOSITION] === "before");
  const after = entries.filter((entry) => entry[COMPOSITION] === "after");
  const runAdded = async (entry: ChannelEventComposition, args: unknown[]) => {
    try {
      await entry.handler(...args);
    } catch (error) {
      logError(log, `${channel} ${entry[COMPOSITION]}Default handler for ${key} failed`, error);
    }
  };
  return async (...args: unknown[]) => {
    for (const entry of before) await runAdded(entry, args);
    await core?.(...args);
    for (const entry of after) await runAdded(entry, args);
  };
}
