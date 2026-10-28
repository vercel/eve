import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { browserCommand, type BrowserCommand } from "@eve-start/protocol";
import type { DB } from "../db.ts";
const now = () => Date.now();
const unavailable =
  "The cloud browser is not configured. Run ./scripts/setup.sh, then restart or redeploy.";
export type ComputerOptions = {
  origin?: string;
  desktop?: {
    ready: (id: string) => Promise<unknown>;
    healthy: (id: string) => Promise<boolean>;
    start: (id: string) => unknown;
    status: (id: string) => Promise<unknown>;
    link: (id: string) => Promise<unknown>;
    stream: (id: string) => Promise<unknown>;
    execute: (id: string, command: BrowserCommand) => Promise<{ result: unknown }>;
    stop: (id: string) => Promise<unknown>;
  };
};
/** One cloud browser per app: dashboard controls and direct agent commands. */
export function installComputerRoutes(app: Hono<any>, db: DB, options: ComputerOptions = {}) {
  const desktop = options.desktop;
  app.get("/v1/mobile/desktop", async (c) =>
    c.json(desktop ? await desktop.status(c.get("agent").id) : { state: "unavailable" }),
  );
  app.post("/v1/mobile/desktop", async (c) => {
    if (!desktop) return c.json({ error: unavailable }, 503);
    desktop.start(c.get("agent").id);
    return c.json({ state: "starting" }, 202);
  });
  app.post("/v1/mobile/desktop/stream", async (c) =>
    desktop ? c.json(await desktop.stream(c.get("agent").id)) : c.json({ error: unavailable }, 503),
  );
  app.post("/v1/mobile/desktop/link", async (c) =>
    desktop ? c.json(await desktop.link(c.get("agent").id)) : c.json({ error: unavailable }, 503),
  );
  app.delete("/v1/mobile/desktop", async (c) =>
    desktop ? c.json(await desktop.stop(c.get("agent").id)) : c.json({ error: unavailable }, 503),
  );
  app.post("/v1/agent/browser/execute", async (c) => {
    const command = browserCommand.parse(await c.req.json()),
      agentId = c.get("agent").id;
    if (!desktop) return c.json({ error: unavailable }, 503);
    // Wake before recording the action: startup is safe to retry, browser actions are not.
    try {
      await desktop.ready(agentId);
    } catch (error) {
      return c.json({ error: "Cloud browser could not start: " + (error as Error).message }, 503);
    }
    const id = randomUUID(),
      time = now();
    await db.query(
      "INSERT INTO jobs(id,agent_id,command,state,expires,created) VALUES($1,$2,$3,'running',$4,$5)",
      [id, agentId, JSON.stringify(command), time + 90_000, time],
    );
    try {
      const { result } = await desktop.execute(agentId, command);
      await db.query("UPDATE jobs SET state='done',result=$1 WHERE id=$2", [
        JSON.stringify(result ?? null),
        id,
      ]);
      return c.json({ id, executed: true, result, durationMs: now() - time });
    } catch (error) {
      const message = (error as Error).message;
      await db.query("UPDATE jobs SET state='done',error=$1 WHERE id=$2", [
        message.slice(0, 4000),
        id,
      ]);
      // The action may have run before the connection failed, so it is never retried.
      return c.json({ error: message, id, outcomeMayBeUnknown: true }, 502);
    }
  });
}
