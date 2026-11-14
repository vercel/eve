export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
}

/** eve's `ClientSessionState`, persisted as is so a restored session keeps its `inbox` handle. */
export interface EveSessionCursor {
  /** Opaque routing handle the server issues; pass it back unchanged. */
  inbox?: string;
  sessionId: string;
  streamIndex: number;
}

export interface ThreadState {
  session: EveSessionCursor;
  events: unknown[];
}

export interface ThreadRecord extends ThreadSummary {
  state: ThreadState | null;
}

export function truncateThreadTitle(text: string, maxLength = 60): string {
  const line = text.trim().split("\n")[0]?.trim() || "New chat";
  if (line.length <= maxLength) {
    return line;
  }

  return `${line.slice(0, maxLength - 1)}…`;
}
