export interface SessionActivity {
  readonly lastMessageAt?: string;
  readonly lastTurnAt?: string;
}

export interface ChatSession extends SessionActivity {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
}

export interface SessionHistory {
  readonly sessions: readonly ChatSession[];
  readonly nextCursor?: string;
  readonly viewer: {
    readonly id: string;
    readonly name: string;
    readonly source: "local" | "user";
  };
}

export function applySessionActivity(
  activity: SessionActivity,
  event: { readonly type: string; readonly meta?: { readonly at?: string } },
): SessionActivity {
  const at = event.meta?.at;
  if (!at || !Number.isFinite(Date.parse(at))) return activity;
  if (
    ["message.received", "message.appended", "message.completed"].includes(event.type) &&
    (!activity.lastMessageAt || Date.parse(at) > Date.parse(activity.lastMessageAt))
  )
    return { ...activity, lastMessageAt: at };
  if (
    event.type === "turn.started" &&
    (!activity.lastTurnAt || Date.parse(at) > Date.parse(activity.lastTurnAt))
  )
    return { ...activity, lastTurnAt: at };
  return activity;
}

export function sortSessions(sessions: readonly ChatSession[]): ChatSession[] {
  return [...sessions].sort(
    (a, b) =>
      Date.parse(b.lastMessageAt ?? b.createdAt) - Date.parse(a.lastMessageAt ?? a.createdAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
