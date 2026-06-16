import { defineChannel, POST } from "eve/channels";

/**
 * Receive-only target channel for the cross-channel handoff smoke
 * test. The POST route exists only to satisfy the channel manifest's
 * "every channel mounts at least one route" requirement.
 */
export default defineChannel({
  routes: [POST("/target", async () => new Response("ok"))],
  async receive(input, { send }) {
    const sessionRef =
      typeof input.target.sessionRef === "string" ? input.target.sessionRef : "default";
    return send(input.message, {
      auth: input.auth,
      continuationToken: `target:${sessionRef}`,
    });
  },
});
