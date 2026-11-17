import type {
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
  ProviderV4,
} from "@ai-sdk/provider";
import { gateway, type LanguageModel, wrapLanguageModel } from "ai";

export function withUniqueCallIds(model: LanguageModel, taken: Iterable<string>): LanguageModel {
  return wrapLanguageModel({ model: resolved(model), middleware: uniqueCallIds(new Set(taken)) });
}

function resolved(model: LanguageModel) {
  if (typeof model !== "string") return model;
  const provider = Reflect.get(globalThis, "AI_SDK_DEFAULT_PROVIDER") as ProviderV4 | undefined;
  return (provider ?? gateway).languageModel(model);
}

function uniqueCallIds(taken: Set<string>): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();
      return { ...rest, stream: stream.pipeThrough(renameRepeatedCalls(taken)) };
    },
  };
}

function renameRepeatedCalls(
  taken: Set<string>,
): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  const renamed = new Map<string, string>();
  const streaming = new Set<string>();
  const introduce = (id: string): string => {
    let next = id;
    for (let n = 2; taken.has(next); n++) next = `${id}_${n}`;
    taken.add(next);
    if (next === id) renamed.delete(id);
    else renamed.set(id, next);
    return next;
  };
  const current = (id: string) => renamed.get(id) ?? id;
  return new TransformStream({
    transform(part, controller) {
      switch (part.type) {
        case "tool-input-start":
          streaming.add(part.id);
          controller.enqueue({ ...part, id: introduce(part.id) });
          return;
        case "tool-input-delta":
        case "tool-input-end":
          controller.enqueue({ ...part, id: current(part.id) });
          return;
        case "tool-call": {
          const id = streaming.delete(part.toolCallId)
            ? current(part.toolCallId)
            : introduce(part.toolCallId);
          controller.enqueue({ ...part, toolCallId: id });
          return;
        }
        case "tool-result":
        case "tool-approval-request":
          controller.enqueue({ ...part, toolCallId: current(part.toolCallId) });
          return;
        default:
          controller.enqueue(part);
      }
    },
  });
}
