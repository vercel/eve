import { mockModel } from "eve/evals";
import { respond } from "./respond.ts";

export function continuationModel() {
  const model = mockModel({ modelId: "hitl-continuation", respond });
  if (typeof model === "string" || model.specificationVersion !== "v3") {
    throw new Error("This fixture expects mockModel's v3 provider boundary.");
  }
  const generate = model.doGenerate.bind(model);
  model.doGenerate = async (options) => {
    const response = await generate(options);
    const content: typeof response.content = [];
    for (const part of response.content) {
      if (part.type === "tool-call" && part.toolCallId === "provider-lookup") {
        content.push({ ...part, providerExecuted: true });
        content.push({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: { draftId: "draft-3494", status: "provider-ready" },
        });
      } else content.push(part);
    }
    return { ...response, content };
  };
  const stream = model.doStream.bind(model);
  type Part =
    Awaited<ReturnType<typeof stream>>["stream"] extends ReadableStream<infer T> ? T : never;

  // Model the provider's own result on the provider stream, not as a local tool
  // return. This leaves an assistant message at the end of the model history.
  model.doStream = async (options) => {
    const response = await stream(options);
    return {
      ...response,
      stream: response.stream.pipeThrough(
        new TransformStream<Part, Part>({
          transform(part, controller) {
            if (part.type === "tool-call" && part.toolCallId === "provider-lookup") {
              controller.enqueue({ ...part, providerExecuted: true });
              controller.enqueue({
                type: "tool-result",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                result: { draftId: "draft-3494", status: "provider-ready" },
              });
            } else controller.enqueue(part);
          },
        }),
      ),
    };
  };
  return model;
}
