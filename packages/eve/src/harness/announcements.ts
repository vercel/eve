import type { ContextContainer } from "#context/container.js";
import { ContextKey } from "#context/key.js";

/**
 * Framework state announced to the model as an append-only `context.state`
 * message. The harness appends a message only when `value` differs from the
 * last value it announced for the same key, so the cached prompt prefix never
 * changes. Compaction clears the record, which makes the next announcement a
 * fresh baseline.
 */
export interface Announcement {
  /** Canonical state. Only a changed value produces a message. */
  readonly value: string;
  /**
   * Renders the message for `value`. `previous` is the last announced value,
   * or `undefined` for a baseline. Returning `undefined` records the value
   * without adding a message.
   */
  render(previous: string | undefined): string | undefined;
}

/** Step-local announcements keyed by producer, set before the model call. */
const PendingAnnouncementsKey = new ContextKey<Readonly<Record<string, Announcement>>>(
  "eve.pendingAnnouncements",
);

/** Sets or clears the announcement `key` for the current step. */
export function setPendingAnnouncement(
  ctx: ContextContainer,
  key: string,
  announcement: Announcement | undefined,
): void {
  const { [key]: _previous, ...rest } = ctx.get(PendingAnnouncementsKey) ?? {};
  ctx.setVirtualContext(
    PendingAnnouncementsKey,
    announcement === undefined ? rest : { ...rest, [key]: announcement },
  );
}

/** The announcements set for the current step. */
export function getPendingAnnouncements(
  ctx: Pick<ContextContainer, "get"> | undefined,
): Readonly<Record<string, Announcement>> {
  return ctx?.get(PendingAnnouncementsKey) ?? {};
}
