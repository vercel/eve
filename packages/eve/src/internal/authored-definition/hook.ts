import type { SessionEvent } from "#protocol/session-event.js";
import { assertHookForm, type StreamEventHook } from "#public/definitions/hook.js";
import { removedEventKeyMessage } from "#public/definitions/removed-event-keys.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import { expectFunction, expectObjectRecord } from "#internal/authored-module.js";

/** A hook export's handlers, by the event they handle: `{ events?: { [event]: handler } }`. */
export function normalizeHookHandlers(
  value: unknown,
  source: Pick<ModuleSourceRef, "exportName" | "logicalPath">,
): Readonly<Record<string, StreamEventHook<SessionEvent>>> {
  const subject = `the hook export "${source.exportName ?? "default"}" from "${source.logicalPath}"`;
  const record = expectObjectRecord(value, `Expected ${subject} to return an object.`);
  assertHookForm(
    record,
    `The hook export "${source.exportName ?? "default"}" from "${source.logicalPath}"`,
  );
  const events =
    record.events === undefined
      ? {}
      : expectObjectRecord(record.events, `Expected ${subject} to expose \`events\` as an object.`);
  const handlers: Record<string, StreamEventHook<SessionEvent>> = {};
  for (const [key, handler] of Object.entries(events)) {
    if (handler === undefined) continue;
    const removed = removedEventKeyMessage(key);
    if (removed !== undefined) throw new Error(`Hook "${source.logicalPath}" handles ${removed}`);
    handlers[key] = expectFunction(
      handler,
      `Expected ${subject} to provide a function for "events.${key}".`,
    ) as StreamEventHook<SessionEvent>;
  }
  return handlers;
}
