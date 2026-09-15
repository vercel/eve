import { defineChannel, POST } from "eve/channels";

/**
 * Receive-only target channel for the cross-channel handoff smoke
 * test. The POST route exists only to satisfy the channel manifest's
 * "every channel mounts at least one route" requirement.
 */
export default defineChannel({
  audience({ caller }) {
    return caller.type === "principal" && caller.principal.kind === "service"
      ? "private"
      : "unknown";
  },
  routes: [POST("/target", async () => new Response("ok"))],
  async receive(input, { from }) {
    const sessionRef =
      typeof input.target.sessionRef === "string" ? input.target.sessionRef : "default";
    return from(`target:${sessionRef}`).send(input.message, {
      auth: input.auth,
    });
  },
});
