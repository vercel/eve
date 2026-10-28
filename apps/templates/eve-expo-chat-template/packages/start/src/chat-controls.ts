import type { DB } from "./computer-db.ts";
import { contentCutoff } from "./content-retention.ts";

export async function stopResponse(
  db: DB,
  agentId: string,
  eventId: string,
  cancel: (sessionId: string, turnId: string) => Promise<unknown>,
) {
  const [turn] = await db.query<{ session_id: string; turn_id: string }>(
    `SELECT d.session_id,d.turn_id FROM native_deliveries d
     JOIN messages m ON m.agent_id=d.agent_id AND m.id=d.event_id
     WHERE d.agent_id=$1 AND d.event_id=$2 AND m.role='user' AND m.event_done=0
     AND m.created>$3 AND d.session_id IS NOT NULL AND d.turn_id IS NOT NULL`,
    [agentId, eventId, contentCutoff()],
  );
  if (!turn) return { status: "no_active_turn" };
  return cancel(turn.session_id, turn.turn_id);
}
