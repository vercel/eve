// Test-only provisioning. Production app deployments expose no tenant/admin control plane.
import { Hono } from "hono";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createApp as appApi } from "../packages/start/server/app.ts";
import type { DB } from "../packages/start/server/db.ts";
import { pairingCode, normalizePairingToken } from "../packages/start/server/pairing.ts";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
export function createApp(
  db: DB,
  admin: string,
  pushFetch: typeof fetch = fetch,
  options: Parameters<typeof appApi>[3] & { web?: boolean } = {},
) {
  const app = new Hono();
  app.post("/v1/admin/agents", async (c) => {
    if (c.req.header("Authorization") !== "Bearer " + admin)
      return c.json({ error: "Unauthorized" }, 401);
    const { name } = await c.req.json(),
      agentId = randomUUID(),
      agentToken = secret(),
      desktopToken = secret(),
      cloudToken = secret(),
      pairingToken = pairingCode();
    await db.query("INSERT INTO agents(id,name,agent_hash,desktop_hash) VALUES($1,$2,$3,$4)", [
      agentId,
      name,
      hash(agentToken),
      hash(desktopToken),
    ]);
    await db.query("INSERT INTO desktop_keys(agent_id,token_hash) VALUES($1,$2)", [
      agentId,
      hash(cloudToken),
    ]);
    await db.query("INSERT INTO pairs(hash,agent_id,expires) VALUES($1,$2,$3)", [
      hash(normalizePairingToken(pairingToken)),
      agentId,
      Date.now() + 60000,
    ]);
    return c.json({ agentId, agentToken, desktopToken, cloudToken, pairingToken }, 201);
  });
  const api = appApi(db, admin, pushFetch, options);
  app.all("*", (c) => api.fetch(c.req.raw));
  return app;
}
