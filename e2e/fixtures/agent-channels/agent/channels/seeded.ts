import { defineChannel, POST } from "eve/channels";

const AUTH = {
  attributes: {},
  authenticator: "seeded",
  principalId: "seeded-history-eval",
  principalType: "service",
} as const;

const ALICE_EARLIER = [
  {
    id: "alice-1",
    role: "user",
    content: "Hi, this is Alice. Which code word should the launch checklist use?",
  },
  { id: "agent-1", role: "assistant", content: "Alice, the launch checklist code word is heron." },
] as const;

const BOB_LATER = [
  { id: "bob-1", role: "user", content: "Hi, this is Bob. Please rotate the checklist code word." },
  { id: "agent-2", role: "assistant", content: "Done, Bob. The checklist code word is now egret." },
] as const;

/**
 * An app that stores its own transcripts: `create` starts a session from
 * Alice's earlier conversation, and `send` can carry a later exchange with
 * Bob that happened elsewhere.
 */
export default defineChannel({
  routes: [
    POST("/seeded", async (req, { from }) => {
      const body = (await req.json().catch(() => ({}))) as {
        message?: string;
        mode?: "create" | "send";
        sessionRef?: string;
        withBob?: boolean;
      };
      const address = from(`seeded:${body.sessionRef ?? crypto.randomUUID()}`);
      const session =
        body.mode === "create"
          ? await address.create({ auth: AUTH, history: [...ALICE_EARLIER] })
          : await address.send(body.message ?? "What did we agree on?", {
              auth: AUTH,
              history: body.withBob === true ? [...BOB_LATER] : undefined,
            });
      return Response.json({ ok: true, sessionId: session.id });
    }),
  ],
});
