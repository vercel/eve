import type { SessionPublication } from "#harness/types.js";
import { eventsOf } from "#harness/publication.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { createStreamChecker, type StreamChecker } from "#protocol/session-events/checker.js";
import { encodeLineBytes, type StoredLine } from "#protocol/session-events/envelope.js";
import { linesOf } from "#protocol/session-lines.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { checksSessionEvents } from "#shared/dev-checks.js";
import { cascade } from "./cascade.js";

export interface CommittedLine {
  readonly line: StoredLine<SessionEvent, SessionEvent>;
  readonly bytes: Uint8Array;
  readonly position: number;
}

export interface LineCommitter {
  commit(
    view: SessionView,
    publication: SessionPublication,
    position: number,
    at?: string,
  ): readonly CommittedLine[];
  reset(): void;
}

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
