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
   * or `undefined` for a baseline.
   */
  render(previous: string | undefined): string;
}
