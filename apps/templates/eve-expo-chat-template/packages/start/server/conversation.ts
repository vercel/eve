import type { DB } from "./db.ts";
import { contentCutoff } from "./retention.ts";
import { responseId } from "@eve-start/sdk";
type Row = Record<string, any>;
export async function conversation(db: DB, agentId: string, asOf = Date.now()) {
  // One database snapshot prevents a final reply disappearing between history and draft reads.
  const rows = await db.query<Row>(
    `WITH recent AS (
    SELECT id,role,text,tools,created,event_done FROM messages WHERE agent_id=$1 AND created>$2 ORDER BY created DESC,role ASC,id DESC LIMIT 200
  ), active AS (
    SELECT d.event_id,m.created FROM native_deliveries d JOIN messages m ON m.id=d.event_id AND m.agent_id=d.agent_id
    WHERE d.agent_id=$1 AND m.role='user' AND m.event_done=0 AND m.created>$2 AND d.turn_id IS NOT NULL
    ORDER BY m.created,m.id LIMIT 1
  ) SELECT 'message' AS kind,id,NULL AS event_id,role,text,tools,NULL AS status,created,created AS updated,event_done FROM recent
  UNION ALL SELECT 'stream' AS kind,id,event_id,'assistant' AS role,text,tools,status,created,updated,1 AS event_done FROM message_streams WHERE agent_id=$1 AND created>$2
  UNION ALL SELECT 'model','model',NULL,NULL,value,NULL,NULL,0,0,1 FROM agent_state WHERE agent_id=$1 AND key='chat.model'
  UNION ALL SELECT 'active',event_id,NULL,NULL,'',NULL,NULL,created,created,1 FROM active
  ORDER BY created,role DESC,id`,
    [agentId, contentCutoff(asOf)],
  );
  return {
    asOf,
    model: JSON.parse(rows.find((r) => r.kind === "model")?.text || "null") as string | null,
    activeResponse: (rows.find((r) => r.kind === "active")?.id || null) as string | null,
    messages: rows
      .filter((r) => r.kind === "message")
      .map((r) => ({
        id: r.id,
        role: r.role,
        text: r.text,
        ...(r.tools && r.tools !== "[]" ? { tools: JSON.parse(r.tools) } : {}),
        createdAt: Number(r.created),
        ...(r.role === "user" ? { pending: !r.event_done, responseId: responseId(r.id) } : {}),
      })),
    streams: rows
      .filter((r) => r.kind === "stream")
      .map((r) => ({
        id: r.id,
        eventId: r.event_id,
        role: "assistant",
        text: r.text,
        ...(r.tools && r.tools !== "[]" ? { tools: JSON.parse(r.tools) } : {}),
        status: r.status,
        createdAt: Number(r.created),
        updatedAt: Number(r.updated),
      })),
  };
}
