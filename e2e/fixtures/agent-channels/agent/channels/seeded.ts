import { defineChannel, POST, type SessionHistoryMessage } from "eve/channels";

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
    text: "Hi, this is Alice. Which code word should the launch checklist use?",
  },
  { id: "agent-1", role: "assistant", text: "Alice, the launch checklist code word is heron." },
] as const;

const ALICE_WITH_FILE: readonly SessionHistoryMessage[] = [
  {
    id: "alice-file-1",
    parts: [
      { text: "Hi, this is Alice. Here is our signed contract.", type: "text" },
      {
        data: new URL("seeded-file://contract.pdf"),
        filename: "contract.pdf",
        mediaType: "application/pdf",
        type: "file",
      },
    ],
    role: "user",
  },
  { id: "agent-file-1", role: "assistant", text: "Thanks Alice, I have the contract." },
];

const BOB_LATER = [
  { id: "bob-1", role: "user", text: "Hi, this is Bob. Please rotate the checklist code word." },
  { id: "agent-2", role: "assistant", text: "Done, Bob. The checklist code word is now egret." },
] as const;

const CONTRACT_PDF = Buffer.from("%PDF-1.4\n% Seeded fixture contract\n%%EOF\n", "utf8");

/**
 * An app that stores its own transcripts: `create` starts a session from
 * Alice's earlier conversation, `create-with-file` starts from a conversation
 * containing a channel-resolved PDF reference, and `send` can carry a later
 * exchange with Bob that happened elsewhere.
 */
export default defineChannel({
  async fetchFile(url) {
    if (url === "seeded-file://contract.pdf") {
      return { bytes: CONTRACT_PDF, filename: "contract.pdf", mediaType: "application/pdf" };
    }
    return null;
  },
  routes: [
    POST("/seeded", async (req, { from }) => {
      const body = (await req.json().catch(() => ({}))) as {
        message?: string;
        mode?: "create" | "create-with-file" | "send";
        sessionRef?: string;
        withBob?: boolean;
      };
      const address = from(`seeded:${body.sessionRef ?? crypto.randomUUID()}`);
      if (body.mode === "create" || body.mode === "create-with-file") {
        const { created, session } = await address.create({
          auth: AUTH,
          history: body.mode === "create-with-file" ? ALICE_WITH_FILE : [...ALICE_EARLIER],
        });
        return Response.json({ created, ok: true, sessionId: session.id });
      }
      const delivery = await address.send(body.message ?? "What did we agree on?", {
        auth: AUTH,
        history: body.withBob === true ? [...BOB_LATER] : undefined,
      });
      return Response.json({ ok: true, sessionId: delivery.sessionId });
    }),
  ],
});
