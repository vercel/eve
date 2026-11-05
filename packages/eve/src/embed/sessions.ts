import { createWorldSessionStore } from "#execution/in-process/world-store.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";

// The sessions a World keeps for embedded agents, for a program that lists them or continues the
// latest (`createSession(agent, { world, resume: id })`).

/** One session a World keeps. */
export interface SavedSession {
  readonly id: string;
  /** When it was last saved: after its last step. */
  readonly savedAt: Date;
  /** A turn was open when it was last saved, which resuming it continues. */
  readonly open: boolean;
}

/** The sessions `world` keeps, most recently saved first. */
export async function listSessions(world: RuntimeWorld): Promise<readonly SavedSession[]> {
  const stored = await createWorldSessionStore(world).list();
  return stored.map(({ open, savedAt, sessionId }) => ({ id: sessionId, open, savedAt }));
}
