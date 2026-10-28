import { createHmac } from "node:crypto";
import { createApp } from "../app.ts";
import type { DB } from "../db.ts";
import type { ComputerOptions } from "./routes.ts";
/** One app owns chat, sessions, push registrations, durable work and its browser. */
export function computerApp(
  db: DB,
  _agentId: string,
  agentToken: string,
  options: ComputerOptions & {
    onMessage?: (id: string) => void;
    onStop?: (eventId: string) => Promise<unknown>;
    onWarm?: () => Promise<{ state: string }>;
    pairing?: () => Promise<unknown>;
    pushFetch?: typeof fetch;
  } = {},
) {
  const admin = createHmac("sha256", agentToken).update("eve-start-app-admin").digest("base64url");
  return createApp(db, admin, options.pushFetch || fetch, options);
}
