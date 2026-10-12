import { createHubVercelWorld } from "./index.js";

/** Workflow SDK factory for hub persistence with Vercel Queues. */
export function createWorld() {
  const url = process.env.WORLD_HUB_URL;
  const secret = process.env.WORLD_HUB_SECRET;
  if (!url || !secret) throw new Error("WORLD_HUB_URL and WORLD_HUB_SECRET are required");
  return createHubVercelWorld({ url, secret });
}
export default createWorld;
