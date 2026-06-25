import { defineChannel, POST } from "eve/channels";

const STREAMED_ACTION_TOOL = "streamed-action";

interface ActionNarrationState {
  observedNarration: string | null;
  pendingNarration: string | null;
}

interface ActionNarrationRequest {
  readonly message: string;
  readonly token: string;
}

function initialState(): ActionNarrationState {
  return { observedNarration: null, pendingNarration: null };
}

function firstNonEmptyLine(message: string): string | null {
  for (const line of message.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRequestValue(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  return Reflect.get(body, key);
}

async function readRequest(request: Request): Promise<ActionNarrationRequest> {
  const body = await request.json().catch(() => null);
  const token = readNonEmptyString(readRequestValue(body, "token")) ?? crypto.randomUUID();
  const message =
    readNonEmptyString(readRequestValue(body, "message")) ??
    "Reply with the single word: action-narration.";
  return { message, token };
}

function continuationToken(token: string): string {
  return `action-narration:${token}`;
}

/**
 * Fixture channel that records the narration a channel handler can observe
 * when a streamed action request arrives. The next turn exposes that durable
 * observation through a dynamic tool so the eval can inspect it over HTTP.
 */
export default defineChannel({
  state: initialState(),

  context(state) {
    return { state };
  },

  metadata(state) {
    return { observedNarration: state.observedNarration };
  },

  routes: [
    POST<ActionNarrationState>("/action-narration/start", async (request, { send }) => {
      const input = await readRequest(request);
      const session = await send(input.message, {
        auth: null,
        continuationToken: continuationToken(input.token),
        state: initialState(),
      });
      return Response.json({ sessionId: session.id });
    }),
  ],

  events: {
    "turn.started"(_event, channel) {
      channel.state.pendingNarration = null;
    },

    "message.completed"(event, channel) {
      if (event.finishReason !== "tool-calls") return;
      channel.state.pendingNarration = event.message ? firstNonEmptyLine(event.message) : null;
    },

    "actions.requested"(event, channel) {
      const requestedStreamedAction = event.actions.some(
        (action) => action.kind === "tool-call" && action.toolName === STREAMED_ACTION_TOOL,
      );
      if (!requestedStreamedAction) return;

      channel.state.observedNarration = channel.state.pendingNarration;
      channel.state.pendingNarration = null;
    },
  },
});
