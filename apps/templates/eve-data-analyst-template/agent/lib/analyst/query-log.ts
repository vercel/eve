import { defineState } from "#lib/state";

/** Most queries attached to one reply. */
const MAX_ATTACHED_QUERIES = 3;

/** One successful run_sql query, as attached to the reply. */
export interface LoggedQuery {
  readonly purpose: string;
  /** ISO timestamp of when the query ran. */
  readonly ranAt: string;
  readonly sql: string;
  /** Tables and views the query read, as `schema.relation`. */
  readonly tables: readonly string[];
}

const turnQueries = defineState<{
  queries: LoggedQuery[];
  turnId: string;
} | null>("analyst.turn-queries", () => null);

/**
 * Records a successful query for the current turn, keeping the most recent ones.
 *
 * @param turnId - Turn the query ran in.
 * @param query - Exact SQL, purpose, tables, and time.
 */
export const recordQuery = (turnId: string, query: LoggedQuery): void => {
  turnQueries.update((current) => ({
    queries: [
      ...(current?.turnId === turnId ? current.queries : []),
      query,
    ].slice(-MAX_ATTACHED_QUERIES),
    turnId,
  }));
};

/**
 * Reads the queries recorded for a turn.
 *
 * @param turnId - Turn whose reply is being posted.
 * @returns Up to three successful queries, oldest first, or none for another turn.
 */
export const queriesForTurn = (turnId: string): readonly LoggedQuery[] => {
  const current = turnQueries.get();
  return current?.turnId === turnId ? current.queries : [];
};

/**
 * Moves a turn's recorded queries to the turn that resumes it.
 *
 * @param fromTurnId - Turn that recorded the queries.
 * @param toTurnId - Turn that will post the reply.
 */
export const transferQueries = (fromTurnId: string, toTurnId: string): void => {
  turnQueries.update((current) =>
    current?.turnId === fromTurnId ? { ...current, turnId: toTurnId } : current
  );
};
