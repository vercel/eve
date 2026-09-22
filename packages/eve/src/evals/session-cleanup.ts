interface CleanupSession {
  readonly sessionId: string | undefined;
  cleanup(signal: AbortSignal): Promise<void>;
}

/** Settles each distinct eval-owned root once. */
export async function cleanupEvalSessions(
  sessions: readonly CleanupSession[],
  signal: AbortSignal,
): Promise<readonly PromiseSettledResult<void>[]> {
  const known = new Map<string, CleanupSession>();
  for (const session of sessions) {
    const sessionId = session.sessionId;
    if (sessionId !== undefined && !known.has(sessionId)) known.set(sessionId, session);
  }
  return await Promise.allSettled(
    [...known.values()].map(async (session) => await session.cleanup(signal)),
  );
}
