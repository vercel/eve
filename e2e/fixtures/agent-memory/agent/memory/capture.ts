import { defineMemory } from "eve/memory";
import { inMemory, type MemoryDocumentBackend } from "eve/memory/file";
import { vercelBlob } from "eve/memory/file/vercel";

const captures: MemoryDocumentBackend = process.env.VERCEL
  ? vercelBlob({ prefix: "eve/e2e/agent-memory/capture" })
  : inMemory();

interface CaptureState {
  readonly count: number;
  readonly sawAssistant: boolean;
  readonly sawMarker: boolean;
}

export default defineMemory({
  description: "Regression probe for completed-turn capture.",
  provider: {
    recall: {
      async "turn.started"(ctx) {
        const document = await captures.read({
          key: ctx.memory.scope.key,
          signal: ctx.abortSignal,
        });
        if (document === null) return null;
        return { messages: [{ content: document.content, id: "capture-state" }] };
      },
    },
    capture: {
      async "turn.completed"(ctx) {
        const current = await captures.read({
          key: ctx.memory.scope.key,
          signal: ctx.abortSignal,
        });
        const previous: CaptureState =
          current === null
            ? { count: 0, sawAssistant: false, sawMarker: false }
            : (JSON.parse(current.content) as CaptureState);
        const next: CaptureState = {
          count: previous.count + 1,
          sawAssistant: ctx.messages.some((message) => message.role === "assistant"),
          sawMarker: ctx.messages.some((message) =>
            JSON.stringify(message).includes("CAPTURE-E2E-N7Q4"),
          ),
        };
        await captures.write({
          content: JSON.stringify(next),
          expectedVersion: current?.version ?? null,
          key: ctx.memory.scope.key,
          signal: ctx.abortSignal,
        });
      },
    },
  },
  scope: ({ session }) => session.id,
});
