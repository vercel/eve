import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createAgentTracing, otelTelemetry } from "./index.js";

describe("wrapped model streams", () => {
  it.each(["completed", "failed", "cancelled"])(
    "preserves the stream and waits for %s completion",
    async (outcome) => {
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      const tracing = createAgentTracing({
        telemetry: otelTelemetry({ provider }),
      });
      try {
        const turn = await tracing.turn({
          agentName: "stream",
          identity: { conversationId: "c", runId: "r", turnId: "t" },
          sequence: 0,
        });
        const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
        const completion = Promise.withResolvers<{
          finishReason: string;
          usage: { inputTokens: number };
        }>();
        let pulls = 0;
        const failure = new TypeError("private");
        const source = new ReadableStream<string>(
          {
            pull(controller) {
              pulls++;
              if (outcome === "failed") {
                controller.error(failure);
                completion.reject(failure);
              } else {
                controller.enqueue("answer");
                controller.close();
                completion.resolve({ finishReason: "stop", usage: { inputTokens: 3 } });
              }
            },
            cancel() {
              completion.reject(new DOMException("Cancelled", "AbortError"));
            },
          },
          { highWaterMark: 0 },
        );
        const stream = await attempt.modelStream({ provider: "test", modelId: "model" }, () => ({
          result: source,
          completion: completion.promise,
        }));
        expect(stream).toBe(source);
        expect(pulls).toBe(0);
        let ended = false;
        const ending = turn.complete().then(() => {
          ended = true;
        });
        await Promise.resolve();
        expect(ended).toBe(false);
        if (outcome === "cancelled") await stream.cancel();
        else if (outcome === "failed")
          await expect(stream.getReader().read()).rejects.toBe(failure);
        else expect(await stream.getReader().read()).toMatchObject({ value: "answer" });
        await ending;
        expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
          "chat model",
          "agent.step",
          "invoke_agent stream",
        ]);
        expect(exporter.getFinishedSpans()[0]!.status.code).toBe(outcome === "completed" ? 0 : 2);
      } finally {
        await tracing.shutdown();
      }
    },
  );
});
