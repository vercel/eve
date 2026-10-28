import { Hono } from "hono";
import { conversationPatch } from "../../protocol/src/conversation.ts";
import { contentCutoff } from "./retention.ts";
import { streamSSE } from "hono/streaming";
import { pairingCode, normalizePairingToken, pairingLifetimeMs } from "./pairing.ts";
import { conversation } from "./conversation.ts";
import { installComputerRoutes, type ComputerOptions } from "./browser/routes.ts";
import { bodyLimit } from "hono/body-limit";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { toolCall } from "@eve-start/protocol";
import type { DB } from "./db.ts";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const now = () => Date.now();
type Agent = {
  id: string;
  name: string;
  agent_hash: string;
  desktop_hash: string;
  desktop_seen: number;
  browser_ready: number;
};
type Row = Record<string, any>;
export function createApp(
  db: DB,
  admin: string,
  pushFetch: typeof fetch = fetch,
  options: ComputerOptions & {
    pairing?: () => Promise<unknown>;
    onMessage?: (agentId: string) => void;
    onStop?: (eventId: string) => Promise<unknown>;
    onWarm?: () => Promise<{ state: string }>;
  } = {},
) {
  if (admin.length < 24) throw new Error("App service secret must contain at least 24 characters");
  const app = new Hono<{
    Variables: { agent: Agent; device: Row };
  }>();
  app.use(
    "*",
    bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }),
  );
  app.onError((error, c) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json(
        {
          error: "Invalid request",
          details: error instanceof z.ZodError ? error.issues : undefined,
        },
        400,
      );
    console.error("Relay request failed:", error.message);
    return c.json({ error: "Relay request failed" }, 500);
  });
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  const token = (c: { req: { header: (key: string) => string | undefined } }) =>
    c.req.header("Authorization")?.replace(/^Bearer /, "") || "";
  app.post("/v1/pair", async (c) => {
    const input = z.object({ pairingToken: z.string().min(8).max(100) }).parse(await c.req.json());
    const [pair] = await db.query<Row>(
      "DELETE FROM pairs WHERE hash=$1 AND expires>$2 RETURNING agent_id",
      [hash(normalizePairingToken(input.pairingToken)), now()],
    );
    if (!pair)
      return c.json(
        { error: "Pairing code expired or already used. Get a new code in eve Start." },
        410,
      );
    const deviceToken = secret(),
      id = randomUUID();
    await db.query("INSERT INTO devices(id,agent_id,token_hash) VALUES($1,$2,$3)", [
      id,
      pair.agent_id,
      hash(deviceToken),
    ]);
    const [agent] = await db.query<Row>("SELECT name FROM agents WHERE id=$1", [pair.agent_id]);
    return c.json({ agentId: pair.agent_id, name: agent.name, deviceToken });
  });
  app.use("/v1/agent/*", async (c, next) => {
    const [agent] = await db.query<Agent>("SELECT * FROM agents WHERE agent_hash=$1", [
      hash(token(c)),
    ]);
    if (!agent) return c.json({ error: "Unauthorized" }, 401);
    c.set("agent", agent);
    await next();
  });
  app.get("/v1/agent/me", async (c) =>
    c.json({ agentId: c.get("agent").id, name: c.get("agent").name }),
  );
  app.post("/v1/agent/warm", async (c) => {
    await db.query("SELECT 1");
    const browser = await options.onWarm?.();
    return c.json({ database: "ready", browser: browser?.state || "unavailable" });
  });
  app.use("/v1/mobile/*", async (c, next) => {
    const [device] = await db.query<Row>("SELECT * FROM devices WHERE token_hash=$1", [
      hash(token(c)),
    ]);
    if (!device) return c.json({ error: "Unauthorized" }, 401);
    const [agent] = await db.query<Agent>("SELECT * FROM agents WHERE id=$1", [device.agent_id]);
    c.set("agent", agent);
    c.set("device", device);
    await next();
  });
  // The extension authenticates its web cookie itself, then uses its agent credential here.
  // A derived device capability stays server-side and can never cross agent boundaries.
  app.all("/v1/agent/client/*", async (c) => {
    const id = c.get("agent").id,
      serviceToken = createHmac("sha256", admin)
        .update("start-client:" + id)
        .digest("base64url");
    await db.query(
      "INSERT INTO devices(id,agent_id,token_hash) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash WHERE devices.agent_id=excluded.agent_id",
      ["start-client:" + id, id, hash(serviceToken)],
    );
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace("/v1/agent/client/", "/v1/mobile/");
    const headers = new Headers({
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json",
    });
    return app.fetch(
      new Request(url, {
        method: c.req.method,
        headers,
        body: ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.text(),
        signal: c.req.raw.signal,
      }),
    );
  });
  app.get("/v1/agent/state/:key", async (c) => {
    const key = z
      .string()
      .regex(/^[a-zA-Z0-9_.-]{1,80}$/)
      .parse(c.req.param("key"));
    const [row] = await db.query<Row>(
      "SELECT value FROM agent_state WHERE agent_id=$1 AND key=$2",
      [c.get("agent").id, key],
    );
    return c.json({ value: row ? JSON.parse(row.value) : null });
  });
  app.put("/v1/agent/state/:key", async (c) => {
    const key = z
      .string()
      .regex(/^[a-zA-Z0-9_.-]{1,80}$/)
      .parse(c.req.param("key"));
    const { value } = z.object({ value: z.unknown() }).parse(await c.req.json());
    await db.query(
      "INSERT INTO agent_state(agent_id,key,value) VALUES($1,$2,$3) ON CONFLICT(agent_id,key) DO UPDATE SET value=excluded.value",
      [c.get("agent").id, key, JSON.stringify(value ?? null)],
    );
    return c.json({ ok: true });
  });
  app.post("/v1/agent/pairing", async (c) => {
    if (options.pairing) return c.json(await options.pairing());
    const pairingToken = pairingCode();
    await db.query("DELETE FROM pairs WHERE expires<=$1", [now()]);
    await db.query("INSERT INTO pairs(hash,agent_id,expires) VALUES($1,$2,$3)", [
      hash(normalizePairingToken(pairingToken)),
      c.get("agent").id,
      now() + pairingLifetimeMs,
    ]);
    return c.json({ pairingToken, expiresIn: 60 });
  });
  app.get("/v1/mobile/state", async (c) => {
    const agent = c.get("agent");
    const chat = await conversation(db, agent.id);
    return c.json({
      cloudAvailable: Boolean(options.desktop),
      remoteDesktop: options.desktop ? await options.desktop.status(agent.id) : undefined,
      name: agent.name,
      browserReady: options.desktop ? await options.desktop.healthy(agent.id) : false,
      ...chat,
    });
  });
  app.get("/v1/mobile/events", (c) =>
    streamSSE(c, async (stream) => {
      const agentId = c.get("agent").id,
        deadline = now() + 50_000;
      const patches = c.req.query("v") === "2";
      let snapshot: Awaited<ReturnType<typeof conversation>> | undefined;
      let previous = "",
        heartbeat = 0;
      c.header("Cache-Control", "no-cache, no-transform");
      c.header("X-Accel-Buffering", "no");
      await stream.writeSSE({ event: "ready", data: "{}", retry: 1000 });
      while (!stream.aborted && now() < deadline) {
        const state = await conversation(db, agentId),
          value = JSON.stringify({ ...state, asOf: undefined });
        if (value !== previous) {
          const update = patches && snapshot ? conversationPatch(snapshot, state) : undefined;
          await stream.writeSSE({
            event: update ? "conversation.patch" : "conversation",
            data: JSON.stringify(update || state),
          });
          previous = value;
          snapshot = state;
        } else if (now() - heartbeat > 10000) {
          await stream.writeSSE({ event: "heartbeat", data: "{}" });
          heartbeat = now();
        }
        await stream.sleep(100);
      }
    }),
  );
  app.post("/v1/mobile/messages", async (c) => {
    const { text, id } = z
      .object({ text: z.string().trim().min(1).max(10000), id: z.uuid() })
      .parse(await c.req.json());
    await db.query(
      "INSERT INTO messages(id,agent_id,role,text,created) VALUES($1,$2,'user',$3,$4) ON CONFLICT(id) DO NOTHING",
      [id, c.get("agent").id, text, now()],
    );
    options.onMessage?.(c.get("agent").id);
    return c.json({ id }, 201);
  });
  app.post("/v1/mobile/stop", async (c) => {
    const { id } = z.object({ id: z.uuid() }).parse(await c.req.json());
    const [message] = await db.query(
      "SELECT id FROM messages WHERE id=$1 AND agent_id=$2 AND role='user' AND created>$3",
      [id, c.get("agent").id, contentCutoff()],
    );
    if (!message) return c.json({ error: "Response not found" }, 404);
    if (!options.onStop) return c.json({ error: "Stopping responses is unavailable" }, 503);
    return c.json(await options.onStop(id));
  });
  app.put("/v1/mobile/push", async (c) => {
    const { pushToken } = z
      .object({
        pushToken: z.string().regex(/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/),
      })
      .parse(await c.req.json());
    await db.query("UPDATE devices SET push_token=$1 WHERE id=$2", [pushToken, c.get("device").id]);
    return c.json({ ok: true });
  });
  app.delete("/v1/mobile/session", async (c) => {
    await db.query("DELETE FROM devices WHERE id=$1", [c.get("device").id]);
    return c.json({ ok: true });
  });
  app.put("/v1/agent/streams/:id", async (c) => {
    const id = z.uuid().parse(c.req.param("id"));
    const input = z
      .object({
        eventId: z.uuid(),
        tools: z.array(toolCall).max(100).default([]),
        text: z.string().max(20000),
        status: z.enum(["streaming", "error"]).default("streaming"),
      })
      .parse(await c.req.json());
    const agentId = c.get("agent").id;
    const [event] = await db.query<Row>(
      "SELECT id FROM messages WHERE id=$1 AND agent_id=$2 AND role='user' AND created>$3",
      [input.eventId, agentId, contentCutoff()],
    );
    if (!event) return c.json({ error: "Unknown event" }, 404);
    const [done] = await db.query("SELECT id FROM messages WHERE id=$1 AND agent_id=$2", [
      id,
      agentId,
    ]);
    if (!done)
      await db.query(
        "INSERT INTO message_streams(id,agent_id,event_id,text,status,created,updated,tools) VALUES($1,$2,$3,$4,$5,$6,$6,$7) ON CONFLICT(id) DO UPDATE SET text=excluded.text,status=excluded.status,updated=excluded.updated,tools=excluded.tools WHERE message_streams.agent_id=excluded.agent_id",
        [id, agentId, input.eventId, input.text, input.status, now(), JSON.stringify(input.tools)],
      );
    return c.json({ ok: true });
  });
  app.post("/v1/agent/messages", async (c) => {
    const { text, id, tools } = z
      .object({
        text: z.string().trim().min(1).max(20000),
        id: z.uuid(),
        tools: z.array(toolCall).max(100).default([]),
      })
      .parse(await c.req.json());
    const [draft] = await db.query<Row>(
      "SELECT created FROM message_streams WHERE id=$1 AND agent_id=$2",
      [id, c.get("agent").id],
    );
    const created = draft ? Number(draft.created) : now();
    await db.query(
      "INSERT INTO messages(id,agent_id,role,text,created,event_done,tools) VALUES($1,$2,'assistant',$3,$4,1,$5) ON CONFLICT(id) DO NOTHING",
      [id, c.get("agent").id, text, created, JSON.stringify(tools)],
    );
    await db.query("DELETE FROM message_streams WHERE id=$1 AND agent_id=$2", [
      id,
      c.get("agent").id,
    ]);
    await db.query(
      "INSERT INTO alerts(id,agent_id,dedupe,message_id,text,state,next_attempt,created) VALUES($1,$2,$3,$4,$5,'pending',$6,$7) ON CONFLICT(agent_id,dedupe) DO NOTHING",
      [randomUUID(), c.get("agent").id, `reply:${id}`, id, text, now(), created],
    );
    return c.json({ id }, 201);
  });
  app.get("/v1/agent/events", async (c) => {
    const events = await db.query<Row>(
      "SELECT id,text,created FROM messages WHERE agent_id=$1 AND role='user' AND event_done=0 AND created>$2 ORDER BY created,id LIMIT 8",
      [c.get("agent").id, contentCutoff()],
    );
    return c.json({
      events: events.map((r) => ({ id: r.id, text: r.text, createdAt: Number(r.created) })),
    });
  });
  app.post("/v1/agent/events/:id/ack", async (c) => {
    await db.query("UPDATE messages SET event_done=1 WHERE id=$1 AND agent_id=$2 AND role='user'", [
      c.req.param("id"),
      c.get("agent").id,
    ]);
    return c.json({ ok: true });
  });
  app.get("/v1/agent/history", async (c) => {
    const rows = await db.query<Row>(
      "SELECT id,role,text,created FROM messages WHERE agent_id=$1 AND created>$2 ORDER BY created DESC,id DESC LIMIT 40",
      [c.get("agent").id, contentCutoff()],
    );
    return c.json({
      messages: rows
        .reverse()
        .map((r) => ({ id: r.id, role: r.role, text: r.text, createdAt: Number(r.created) })),
    });
  });
  app.post("/v1/agent/notify", async (c) => {
    const input = z
      .object({ text: z.string().trim().min(1).max(10000), dedupeKey: z.string().min(1).max(500) })
      .parse(await c.req.json());
    const id = randomUUID(),
      messageId = randomUUID(),
      agentId = c.get("agent").id;
    // Store the text with the alert, so retries can recover an interrupted message insert.
    const rows = await db.query<Row>(
      "INSERT INTO alerts(id,agent_id,dedupe,message_id,text,state,next_attempt,created) VALUES($1,$2,$3,$4,$5,'pending',$6,$7) ON CONFLICT(agent_id,dedupe) DO NOTHING RETURNING id",
      [id, agentId, input.dedupeKey, messageId, input.text, now(), now()],
    );
    return c.json({ queued: rows.length > 0 });
  });
  app.post("/v1/agent/notifications/flush", async (c) => {
    const agentId = c.get("agent").id,
      time = now();
    const candidates = await db.query<Row>(
      "SELECT * FROM alerts WHERE agent_id=$1 AND state='pending' AND next_attempt<=$2 AND attempts<10 AND created>$3 ORDER BY next_attempt LIMIT 5",
      [agentId, time, contentCutoff(time)],
    );
    for (const alert of candidates) {
      const claimed = await db.query(
        "UPDATE alerts SET next_attempt=$1,attempts=attempts+1 WHERE id=$2 AND next_attempt=$3 RETURNING id",
        [time + 60_000, alert.id, alert.next_attempt],
      );
      if (!claimed.length) continue;
      const text = alert.text as string;
      await db.query(
        "INSERT INTO messages(id,agent_id,role,text,created,event_done) VALUES($1,$2,'assistant',$3,$4,1) ON CONFLICT(id) DO NOTHING",
        [alert.message_id, agentId, text, Number(alert.created)],
      );
      const devices = await db.query<Row>(
        "SELECT DISTINCT push_token FROM devices WHERE agent_id=$1 AND push_token IS NOT NULL",
        [agentId],
      );
      if (!devices.length) {
        await db.query("UPDATE alerts SET attempts=attempts-1 WHERE id=$1", [alert.id]);
        continue;
      }
      try {
        const response = await pushFetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(process.env.EXPO_ACCESS_TOKEN
              ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
              : {}),
          },
          body: JSON.stringify(
            devices.slice(0, 100).map((d) => ({
              to: d.push_token,
              title: c.get("agent").name,
              body: text.slice(0, 180),
              sound: "default",
              data: { agentId, messageId: alert.message_id },
            })),
          ),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Expo status ${response.status}`);
        const payload = (await response.json()) as {
          data?: { status: string; details?: { error?: string } }[];
        };
        if (!payload.data || payload.data.length !== devices.slice(0, 100).length)
          throw new Error("Invalid Expo response");
        let retry = false;
        for (const [i, ticket] of payload.data.entries()) {
          if (ticket.details?.error === "DeviceNotRegistered")
            await db.query("UPDATE devices SET push_token=NULL WHERE push_token=$1", [
              devices[i].push_token,
            ]);
          else if (ticket.status !== "ok") retry = true;
        }
        if (!retry) await db.query("UPDATE alerts SET state='submitted' WHERE id=$1", [alert.id]);
      } catch (error) {
        console.error("Push submission failed:", (error as Error).message);
      }
    }
    return c.json({ ok: true });
  });
  installComputerRoutes(app, db, options);
  return app;
}
