import { EveClient } from "./relay-client.ts";
import { pruneContent } from "./content-retention.ts";
import { createHash, randomBytes } from "node:crypto";
import { database } from "./computer-db.ts";
import { computerApp } from "./computer-app.ts";
import { DesktopManager } from "./computer-desktop.ts";
import assets from "./computer-assets.ts";
import { client } from "./client.ts";
import { config, appOrigin } from "./config.ts";
let storage: ReturnType<typeof initialize> | undefined;
// Reused across requests so health probes stay cached.
const managers = new Map<string, DesktopManager>();
async function initialize() {
  const settings = config(),
    eve = client();
  const db = await database({
    url: settings.databaseUrl,
    path: settings.sqlitePath,
    kind: "app",
    sandbox: process.env.VERCEL && !settings.databaseUrl ? { secret: eve.token } : undefined,
  });
  const tokenHash = createHash("sha256").update(eve.token).digest("hex");
  const [existing] = await db.query<{ id: string; name: string }>(
    "SELECT id,name FROM agents WHERE agent_hash=$1",
    [tokenHash],
  );
  const identity = settings.agentId
    ? { agentId: settings.agentId, name: settings.name || existing?.name || "eve" }
    : existing
      ? { agentId: existing.id, name: settings.name || existing.name }
      : { agentId: "app-" + tokenHash.slice(0, 32), name: settings.name || "eve" };
  if (settings.name) identity.name = settings.name;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  await db.query(
    "INSERT INTO agents(id,name,agent_hash,desktop_hash) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET agent_hash=excluded.agent_hash,name=excluded.name",
    [identity.agentId, identity.name, hash(eve.token), hash("unpaired:" + eve.token)],
  );
  await pruneContent(db);
  return { db, eve, identity };
}
export async function computer(
  origin: string,
  waitUntil: (task: Promise<unknown>) => void = (task) => {
    void task.catch(console.error);
  },
  onMessage?: () => Promise<unknown>,
  onStop?: (eventId: string) => Promise<unknown>,
) {
  storage ||= initialize().catch((error) => {
    storage = undefined;
    throw error;
  });
  const { db, eve, identity } = await storage;
  origin = appOrigin(origin);
  // Deployments and `pnpm dev` (with a pulled project identity) share one cloud browser.
  let manager = managers.get(origin);
  if (!manager && (process.env.VERCEL || process.env.VERCEL_OIDC_TOKEN)) {
    manager = new DesktopManager(db, { origin, secret: eve.token, assets });
    managers.set(origin, manager);
  }
  const background = (task: Promise<unknown>) =>
    waitUntil(task.catch((error) => console.error("Computer:", error.message)));
  return computerApp(db, identity.agentId, eve.token, {
    origin,
    onMessage: onMessage ? () => background(onMessage()) : undefined,
    onStop,
    onWarm: manager ? () => manager.ensure(identity.agentId) : undefined,
    pairing: () => issuePairing(),
    pushFetch: fetch,
    desktop: manager
      ? {
          ready: (id) => manager.ready(id),
          healthy: (id) => manager.healthy(id),
          start: (id) => background(manager.ensure(id)),
          status: (id) => manager.status(id),
          execute: (id, command) => manager.execute(id, command),
          stream: (id) => manager.stream(id),
          link: (id) => manager.link(id),
          stop: (id) => manager.stop(id),
        }
      : undefined,
  });
}
export async function computerRequest<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const origin = appOrigin();
  const app = await computer(origin);
  const response = await app.request("/v1/" + path.replace(/^mobile\//, "agent/client/"), {
    method,
    headers: { Authorization: "Bearer " + client().token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw Error(result.error || "Computer request failed");
  return result;
}

export async function appStorage() {
  storage ||= initialize().catch((error) => {
    storage = undefined;
    throw error;
  });
  return storage;
}

export async function issuePairing() {
  const { db, identity } = await appStorage(),
    ticket = randomBytes(32).toString("base64url");
  await db.query("DELETE FROM pairs WHERE expires<=$1", [Date.now()]);
  await db.query("INSERT INTO pairs(hash,agent_id,expires) VALUES($1,$2,$3)", [
    createHash("sha256").update(ticket).digest("hex"),
    identity.agentId,
    Date.now() + 90000,
  ]);
  return { pairingToken: ticket, expiresIn: 90 };
}
export async function localClient() {
  const { eve } = await appStorage();
  const value = new EveClient(appOrigin(), eve.token, { bypassToken: config().appBypassToken });
  value.request = computerRequest;
  return value;
}
