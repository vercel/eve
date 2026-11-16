import type { SessionPublication } from "#harness/types.js";
import { eventsOf } from "#harness/publication.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { createStreamChecker, type StreamChecker } from "#protocol/session-events/checker.js";
import { encodeLineBytes, type StoredLine } from "#protocol/session-events/envelope.js";
import { linesOf } from "#protocol/session-lines.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { checksSessionEvents } from "#shared/dev-checks.js";
import { cascade } from "./cascade.js";

// The kernel's side of a commit, which needs no host: what one publication writes over the
// session's view. Its owners' ends close what they leave open (`cascade`), its facts form one
// line and each progress record its own, and, where eve checks what a session writes, every line
// is checked before the first is written. A host writes the bytes and folds each line it wrote.

/** One line a publication writes, encoded, at the position it takes. */
export interface CommittedLine {
  readonly line: StoredLine<SessionEvent, SessionEvent>;
  readonly bytes: Uint8Array;
  readonly position: number;
}

export interface LineCommitter {
  /**
   * The lines `publication` writes over `view`, from `position`. Throws on a violation, before
   * any line is written: an oversize or invalid line must not leave part of a commit behind.
   */
  commit(
    view: SessionView,
    publication: SessionPublication,
    position: number,
    at?: string,
  ): readonly CommittedLine[];
  /** A write failed: the committer forgets what it checked, and reseeds from the next view. */
  reset(): void;
}

/** A committer for one writer, which checks each line against the lines before it. */
export async function createLineCommitter(): Promise<LineCommitter> {
  const validate = checksSessionEvents()
    ? (await import("#protocol/session-events/schemas.js")).schemaViolation
    : undefined;
  let checker: StreamChecker | undefined;
  return {
    commit(view, publication, position, at = new Date().toISOString()) {
      if (validate !== undefined) checker ??= createStreamChecker({ seed: view, validate });
      const lines = linesOf(cascade(view, eventsOf(publication)), at).map((line, index) => ({
        bytes: encodeLineBytes(line),
        line,
        position: position + index,
      }));
      for (const { line, position: at } of lines) {
        const violations = checker?.check(line, at) ?? [];
        if (violations.length === 0) continue;
        checker = undefined;
        throw new Error(
          `Session event contract: ${violations
            .map(
              (violation) =>
                `${violation.rule} at ${violation.position}:${violation.index ?? "progress"}: ${violation.message}`,
            )
            .join("; ")}`,
        );
      }
      return lines;
    },
    reset() {
      checker = undefined;
    },
  };
}
