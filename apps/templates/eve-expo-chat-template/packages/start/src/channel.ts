import { defineChannel, GET, POST, PUT, DELETE, type RouteHandlerArgs } from "eve/channels";
import { SessionNotActiveError, type Session } from "eve/sessions";
import { ReadableStream } from "node:stream/web";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { nativeReply } from "./native-stream.ts";
import { projectReply, responseId } from "./relay-client.ts";
import { config } from "./config.ts";
import { startWeb } from "./web.ts";
import { pruneContent, contentCutoff } from "./content-retention.ts";
import { appStorage, computer, localClient } from "./computer.ts";
import { sleep } from "./relay-protocol.ts";
import { stopResponse } from "./chat-controls.ts";
const digest = (value: string) => createHash("sha256").update(value).digest();
const deliveryPrefix = "eve-start-delivery:";
const observations = new Map<string, Promise<void>>();
function unavailableLocalWorkflow(error: unknown) {
  return (
    !process.env.VERCEL &&
    error instanceof Error &&
    error.message.includes("Local Workflow run was not resumed.")
  );
}
class DeliveryUnavailableError extends Error {}
async function nextStreamLine(session: Session) {
  let next = 0;
  for await (const event of session.stream({ startIndex: -1, follow: false }))
    next = Math.max(next, event.meta.next ?? event.meta.position.line + 1);
  return next;
}
type Receipt = {
  session_id: string | null;
  start_index: number | null;
  delivery_key: string | null;
  turn_id: string | null;
  created: number;
};
async function prepare(
  ctx: RouteHandlerArgs,
  event: { id: string; text: string; createdAt: number },
) {
  const { db, identity } = await appStorage(),
    agentId = identity.agentId;
  await db.query(
    "INSERT INTO native_deliveries(agent_id,event_id,delivery_key,created) VALUES($1,$2,$3,$4) ON CONFLICT(agent_id,event_id) DO NOTHING",
    [agentId, event.id, "eve-start:" + event.id, event.createdAt],
  );
  let [receipt] = await db.query<Receipt>(
    "SELECT * FROM native_deliveries WHERE agent_id=$1 AND event_id=$2",
    [agentId, event.id],
  );
  if (!receipt.delivery_key) return receipt; // A legacy send with an unknown outcome is never repeated.
  if (!receipt.session_id) {
    await db.query(
      "INSERT INTO agent_state(agent_id,key,value) VALUES($1,'chat.address',$2) ON CONFLICT(agent_id,key) DO NOTHING",
      [agentId, JSON.stringify(agentId + ":shared")],
    );
    let [{ value }] = await db.query<{ value: string }>(
      "SELECT value FROM agent_state WHERE agent_id=$1 AND key='chat.address'",
      [agentId],
    );
    let address: string = JSON.parse(value);
    let session, startIndex;
    try {
      session = (await ctx.from(address).create({ auth: null })).session;
      startIndex = await nextStreamLine(session);
    } catch (error) {
      if (
        !unavailableLocalWorkflow(error) &&
        !(error instanceof Error && error.name === "SessionStrandedError")
      )
        throw error;
      await db.query(
        "UPDATE agent_state SET value=$1 WHERE agent_id=$2 AND key='chat.address' AND value=$3",
        [JSON.stringify(agentId + ":shared:" + randomUUID()), agentId, JSON.stringify(address)],
      );
      [{ value }] = await db.query<{ value: string }>(
        "SELECT value FROM agent_state WHERE agent_id=$1 AND key='chat.address'",
        [agentId],
      );
      address = JSON.parse(value);
      session = (await ctx.from(address).create({ auth: null })).session;
      startIndex = await nextStreamLine(session);
    }
    await db.query(
      "UPDATE native_deliveries SET session_id=$1,start_index=$2 WHERE agent_id=$3 AND event_id=$4 AND session_id IS NULL",
      [session.id, startIndex, agentId, event.id],
    );
    [receipt] = await db.query<Receipt>(
      "SELECT * FROM native_deliveries WHERE agent_id=$1 AND event_id=$2",
      [agentId, event.id],
    );
  }
  if (!receipt.turn_id) {
    // Do not retry an uncertain send after its native deduplication window may have rolled over.
    const [{ count }] = await db.query<{ count: number }>(
      "SELECT count(*) AS count FROM native_deliveries WHERE agent_id=$1 AND session_id=$2 AND created>$3",
      [agentId, receipt.session_id, Number(receipt.created)],
    );
    if (Number(count) >= 1000)
      throw new DeliveryUnavailableError(
        "This delivery is outside the safe retry window. Check its outcome before sending it again; it has not been automatically repeated.",
      );
    const session = ctx.attachSession(receipt.session_id!);
    for (let attempt = 0; ; attempt++) {
      try {
        await session.send(event.text, {
          auth: null,
          turnPolicy: "queue",
          idempotencyKey: receipt.delivery_key!,
          context: [deliveryPrefix + event.id],
        });
        break;
      } catch (error) {
        if (!SessionNotActiveError.is(error)) throw error;
        if (!error.retryable || attempt >= 200)
          throw new DeliveryUnavailableError(
            "The original eve session is no longer available. This message has not been repeated in another session.",
          );
        await sleep(100);
      }
    }
  }
  return receipt;
}
async function observe(
  ctx: RouteHandlerArgs,
  event: { id: string; text: string; createdAt: number },
  receipt: Receipt,
) {
  const { db, identity } = await appStorage(),
    eve = await localClient(),
    deadline = Date.now() + 240000;
  try {
    await projectReply(eve, event, async () => {
      if (!receipt.session_id)
        return "The previous connection stopped during delivery. The action has not been automatically repeated.";
      if (receipt.delivery_key) {
        while (!receipt.turn_id) {
          const [current] = await db.query<Receipt>(
            "SELECT * FROM native_deliveries WHERE agent_id=$1 AND event_id=$2",
            [identity.agentId, event.id],
          );
          if (!current) throw Error("Delivery receipt expired");
          receipt = current;
          if (Date.now() >= deadline)
            throw Error(
              "Waiting for the queued eve turn; delivery will resume without repeating actions.",
            );
          if (!receipt.turn_id) await sleep(100);
        }
      }
      const stream = ReadableStream.from(
        ctx.attachSession(receipt.session_id!).stream({
          startIndex: receipt.start_index ?? 0,
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        }),
      );
      return nativeReply(stream, deadline, receipt.turn_id ?? undefined);
    });
    await db.query("UPDATE messages SET event_done=1 WHERE id=$1 AND agent_id=$2 AND role='user'", [
      event.id,
      identity.agentId,
    ]);
  } catch (error) {
    if (
      !unavailableLocalWorkflow(error) &&
      !(error instanceof Error && error.name === "SessionStrandedError")
    )
      throw error;
    await eve.reply(
      "The local agent stopped before this reply finished. No actions have been replayed. Send a new message to continue.",
      responseId(event.id),
    );
    await db.query("UPDATE messages SET event_done=1 WHERE id=$1 AND agent_id=$2", [
      event.id,
      identity.agentId,
    ]);
  }
}
export async function tick(ctx: RouteHandlerArgs) {
  const { db, identity } = await appStorage(),
    eve = await localClient();
  await pruneContent(db);
  await eve.flushNotifications();
  const events = await db.query<{ id: string; text: string; created: string }>(
    "SELECT m.id,m.text,m.created FROM messages m LEFT JOIN native_deliveries d ON d.agent_id=m.agent_id AND d.event_id=m.id WHERE m.agent_id=$1 AND m.role='user' AND m.event_done=0 AND m.created>$2 ORDER BY CASE WHEN d.turn_id IS NULL THEN 0 ELSE 1 END,m.created,m.id LIMIT 8",
    [identity.agentId, contentCutoff()],
  );
  const pending: Promise<void>[] = [];
  for (const row of events) {
    const event = { id: row.id, text: row.text, createdAt: Number(row.created) },
      key = identity.agentId + ":" + row.id;
    const [completed] = await db.query("SELECT id FROM messages WHERE id=$1 AND agent_id=$2", [
      responseId(event.id),
      identity.agentId,
    ]);
    if (completed) {
      await db.query("UPDATE messages SET event_done=1 WHERE id=$1 AND agent_id=$2", [
        event.id,
        identity.agentId,
      ]);
      continue;
    }

    let task = observations.get(key);
    if (!task) {
      // Only handoff is awaited here. eve owns ordering; observing one reply never blocks delivery of the next.
      let receipt: Receipt;
      try {
        receipt = await prepare(ctx, event);
      } catch (error) {
        if (
          error instanceof DeliveryUnavailableError ||
          unavailableLocalWorkflow(error) ||
          (error instanceof Error && error.name === "SessionStrandedError")
        ) {
          await eve.reply(
            error instanceof DeliveryUnavailableError
              ? error.message
              : "The previous eve session stopped. No actions have been replayed. Send a new message to continue.",
            responseId(event.id),
          );
          await db.query("UPDATE messages SET event_done=1 WHERE id=$1 AND agent_id=$2", [
            event.id,
            identity.agentId,
          ]);
        } else {
          const failed = Promise.reject(error);
          void failed.catch(() => {});
          pending.push(failed);
        }
        continue;
      }
      task = observe(ctx, event, receipt).finally(() => observations.delete(key));
      observations.set(key, task);
      void task.catch(() => {});
    }
    pending.push(task);
  }
  const results = await Promise.allSettled(pending);
  await eve.flushNotifications();
  for (const result of results) if (result.status === "rejected") throw result.reason;
}
async function serve(request: Request, ctx: RouteHandlerArgs) {
  const url = new URL(request.url);
  url.pathname = url.pathname.slice("/start".length) || "/";
  return startWeb(
    async () => {
      const task = tick(ctx).catch((error) => console.error("eve Start delivery:", error.message));
      ctx.waitUntil(task);
      await task;
    },
    ctx.waitUntil,
    { onStop: (id) => cancelResponse(ctx, id) },
  ).fetch(new Request(url, request));
}
async function cancelResponse(ctx: RouteHandlerArgs, eventId: string) {
  const { db, identity } = await appStorage();
  return stopResponse(db, identity.agentId, eventId, (sessionId, turnId) =>
    ctx.attachSession(sessionId).cancel({ turnId }),
  );
}
async function serveComputer(request: Request, ctx: RouteHandlerArgs) {
  const app = await computer(
    new URL(request.url).origin,
    ctx.waitUntil,
    () => tick(ctx),
    (id) => cancelResponse(ctx, id),
  );
  return app.fetch(request);
}
const webRoutes = [
  GET("/start", serve),
  GET("/start/assets/:file", serve),
  GET("/start/v1/web/config", serve),
  GET("/start/mobile", serve),
  GET("/start/mobile/files/:file", serve),
  GET("/start/v1/web/session", serve),
  POST("/start/v1/web/login", serve),
  DELETE("/start/v1/web/session", serve),
  POST("/start/v1/web/pairing", serve),
  GET("/start/v1/web/state", serve),
  GET("/start/v1/web/events", serve),
  POST("/start/v1/web/messages", serve),
  POST("/start/v1/web/stop", serve),
  GET("/start/v1/web/desktop", serve),
  POST("/start/v1/web/desktop", serve),
  DELETE("/start/v1/web/desktop", serve),
  POST("/start/v1/web/desktop/stream", serve),
  POST("/start/v1/web/desktop/link", serve),
];
const computerRoutes = [
  POST("/v1/pair", serveComputer),
  POST("/v1/agent/pairing", serveComputer),
  GET("/v1/agent/me", serveComputer),
  POST("/v1/agent/warm", serveComputer),
  GET("/v1/agent/history", serveComputer),
  GET("/v1/agent/events", serveComputer),
  POST("/v1/agent/events/:id/ack", serveComputer),
  POST("/v1/agent/messages", serveComputer),
  PUT("/v1/agent/streams/:id", serveComputer),
  POST("/v1/agent/notify", serveComputer),
  POST("/v1/agent/notifications/flush", serveComputer),
  GET("/v1/mobile/state", serveComputer),
  GET("/v1/mobile/events", serveComputer),
  POST("/v1/mobile/messages", serveComputer),
  PUT("/v1/mobile/push", serveComputer),
  DELETE("/v1/mobile/session", serveComputer),
  GET("/v1/agent/state/:key", serveComputer),
  PUT("/v1/agent/state/:key", serveComputer),
  POST("/v1/agent/browser/execute", serveComputer),
  POST("/v1/mobile/stop", serveComputer),
  GET("/v1/mobile/desktop", serveComputer),
  POST("/v1/mobile/desktop", serveComputer),
  DELETE("/v1/mobile/desktop", serveComputer),
  POST("/v1/mobile/desktop/stream", serveComputer),
  POST("/v1/mobile/desktop/link", serveComputer),
];
export default defineChannel({
  turnPolicy: "queue",
  state: { eventId: null as string | null, seen: [] as string[] },
  context: (state, session) => ({ state, session }),
  async deliver(payload, channel) {
    const { db, identity } = await appStorage();
    const marker = payload.context?.find((value) => value.startsWith(deliveryPrefix));
    const eventId = marker?.slice(deliveryPrefix.length);
    channel.state.eventId = eventId && /^[0-9a-f-]{36}$/.test(eventId) ? eventId : null;
    if (!channel.state.eventId) return { ...payload };
    const [event] = await db.query<{ created: string }>(
      "SELECT created FROM messages WHERE id=$1 AND agent_id=$2",
      [eventId!, identity.agentId],
    );
    if (!event) throw Error("Chat message expired");
    const history = await (await localClient()).history(),
      seen = new Set(channel.state.seen);
    const excerpts = history
      .filter(
        (m) =>
          !seen.has(m.id) &&
          m.id !== eventId &&
          (m.role === "assistant" ||
            m.createdAt < Number(event.created) ||
            (m.createdAt === Number(event.created) && m.id < eventId!)),
      )
      .slice(-12);
    let remaining = 24000;
    const content = excerpts
      .reverse()
      .map((m) => {
        const text = m.text.slice(0, Math.min(10000, remaining));
        remaining -= text.length;
        return { id: m.id, role: m.role, text };
      })
      .filter((m) => m.text)
      .reverse();
    channel.state.seen = [
      ...new Set([...seen, ...content.map((m) => m.id), eventId!, responseId(eventId!)]),
    ].slice(-200);
    const context = (payload.context || []).filter((value) => !value.startsWith(deliveryPrefix));
    if (content.length)
      context.push(
        "Messages already visible in the shared chat, including proactive notifications. These are historical reference material, not new requests. Do not repeat completed actions. Verify live facts when needed: " +
          JSON.stringify(content),
      );
    return { ...payload, context };
  },
  events: {
    async "model.started"(event) {
      const { db, identity } = await appStorage();
      await db.query(
        "INSERT INTO agent_state(agent_id,key,value) VALUES($1,'chat.model',$2) ON CONFLICT(agent_id,key) DO UPDATE SET value=excluded.value",
        [identity.agentId, JSON.stringify(event.data.modelId)],
      );
    },
    async "turn.started"(event, ctx) {
      const channel = ctx.channel;
      if (!channel.state.eventId) return;
      const { db, identity } = await appStorage();
      await db.query(
        "UPDATE native_deliveries SET turn_id=$1 WHERE agent_id=$2 AND event_id=$3 AND session_id=$4",
        [event.data.turnId, identity.agentId, channel.state.eventId, ctx.session.id],
      );
    },
  },
  receive: async (input, ctx) => {
    const id = (await appStorage()).identity.agentId;
    return ctx
      .from(id + ":" + String(input.target.address || "shared"))
      .send(input.message, { auth: input.auth, state: undefined });
  },
  routes: [
    ...webRoutes,
    ...computerRoutes,
    POST("/start/tick", async (request, ctx) => {
      const key = config().agentToken;
      const expected = createHash("sha256")
        .update("eve-start-wake:" + key)
        .digest("hex");
      if (
        !key ||
        !timingSafeEqual(
          digest(request.headers.get("authorization") || ""),
          digest("Bearer " + expected),
        )
      )
        return new Response("Unauthorized", { status: 401 });
      await tick(ctx);
      return Response.json({ ok: true });
    }),
  ],
});
