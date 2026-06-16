import { defineChannel, POST } from "eve/channels";

interface AnchorRequestBody {
  readonly marker?: string;
  readonly message?: string;
  readonly threadId?: string;
}

interface AnchorState {
  anchorToken: string | null;
  completedMessages: string[];
  completedTurns: number;
  turnIds: string[];
}

function initialState(anchorToken: string | null = null): AnchorState {
  return {
    anchorToken,
    completedMessages: [],
    completedTurns: 0,
    turnIds: [],
  };
}

function authFor(phase: "reply" | "start", marker: string) {
  return {
    attributes: { marker, phase },
    authenticator: "anchored-smoke",
    principalId: phase === "start" ? "anchor-origin" : "anchor-replier",
    principalType: "user",
  };
}

function readBody(body: unknown): Required<AnchorRequestBody> {
  const input = body && typeof body === "object" ? (body as AnchorRequestBody) : {};
  const threadId = input.threadId?.trim() || crypto.randomUUID();
  const marker = input.marker?.trim() || `anchor-marker-${threadId}`;
  const message = input.message?.trim() || "Reply with the single word: anchored.";
  return { marker, message, threadId };
}

export default defineChannel({
  state: initialState(),
  context(state) {
    return { state };
  },
  metadata(state) {
    return {
      anchorToken: state.anchorToken ?? "",
      turnCount: state.completedTurns,
    };
  },
  routes: [
    POST<AnchorState>("/anchor/start", async (request, { send }) => {
      const body = readBody(await request.json().catch(() => ({})));
      const anchorToken = `thread:${body.threadId}`;
      const session = await send(body.message, {
        auth: authFor("start", body.marker),
        continuationToken: `pending:${body.threadId}`,
        state: initialState(anchorToken),
      });

      return Response.json({
        ok: true,
        anchorToken,
        initialContinuationToken: `pending:${body.threadId}`,
        sessionId: session.id,
      });
    }),

    POST<AnchorState>("/anchor/reply", async (request, { send }) => {
      const body = readBody(await request.json().catch(() => ({})));
      const anchorToken = `thread:${body.threadId}`;
      const session = await send(body.message, {
        auth: authFor("reply", body.marker),
        continuationToken: anchorToken,
        state: initialState(anchorToken),
      });

      return Response.json({ ok: true, anchorToken, sessionId: session.id });
    }),
  ],
  events: {
    "turn.started"(event, channel) {
      channel.state.turnIds.push(event.turnId);
    },
    "message.completed"(event, channel) {
      channel.state.completedTurns += 1;
      channel.state.completedMessages.push(event.message ?? "");

      const anchorToken = channel.state.anchorToken;
      if (anchorToken !== null && !channel.continuationToken.endsWith(`:${anchorToken}`)) {
        channel.setContinuationToken(anchorToken);
      }
    },
  },
});
