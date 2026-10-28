import { mockModel } from "eve/evals";
import type { EveLanguageModel } from "eve/models";
import { respond } from "./respond.ts";

interface Part {
  readonly type: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly [field: string]: unknown;
}

/** The AI SDK v4 result fields this fixture rewrites; `mockModel()` keeps them opaque. */
interface ProviderResultModel extends EveLanguageModel {
  doGenerate(options: unknown): Promise<{ readonly content: readonly Part[] }>;
  doStream(options: unknown): Promise<{ readonly stream: ReadableStream<Part> }>;
}

export function continuationModel() {
  // mockModel() returns an AI SDK v4 model; checked below before its results are rewritten.
  const model = mockModel({ modelId: "hitl-continuation", respond }) as ProviderResultModel;
  if (model.specificationVersion !== "v4") {
    throw new Error("This fixture expects mockModel's v4 provider boundary.");
  }
  const generate = model.doGenerate.bind(model);
  model.doGenerate = async (options) => {
    const response = await generate(options);
    const content: Part[] = [];
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
