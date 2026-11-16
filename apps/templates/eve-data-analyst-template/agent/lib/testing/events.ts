import { emptySessionView, foldEvents } from "eve/events";
import type { SessionView } from "eve/events";
import type { HookContext, HookEvent } from "eve/hooks";

import { sessionContext } from "./session";

/**
 * Folds public facts into the immutable view an authored handler receives.
 * @param events - Ordered session facts to fold.
 * @returns The observed session snapshot.
 */
export const eventView = (events: readonly HookEvent[]): SessionView =>
  foldEvents(
    emptySessionView(),
    events.map((event, line) => ({
      ...event,
      meta: {
        at: "2026-10-10T00:00:00.000Z",
        endOfLine: true,
        position: { index: 0, line },
      },
    }))
  );

/**
 * Supplies the public hook lifecycle contract without running eve's dispatcher.
 * @param overrides - Handler-specific capabilities and session state.
 * @returns A complete hook context that fails on unexpected cancellation.
 */
export const hookContext = (
  overrides: Partial<HookContext<"turn.started">> = {}
): HookContext<"turn.started"> => ({
  ...sessionContext(),
  agent: { name: "test" },
  cancel: () => {
    throw new Error("Unexpected cancellation.");
  },
  channel: { kind: "channel:slack", metadata: {} },
  memo: (_key, fn) =>
    Promise.resolve(
      fn({ abortSignal: new AbortController().signal, idempotencyKey: "test" })
    ),
  now: new Date("2026-10-10T00:00:00.000Z"),
  occurrence: {
    abortSignal: new AbortController().signal,
    idempotencyKey: "test",
  },
  position: { index: 0, line: 0 },
  turn: null,
  view: emptySessionView(),
  ...overrides,
});
