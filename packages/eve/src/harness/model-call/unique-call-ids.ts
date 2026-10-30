import type {
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
  ProviderV4,
} from "@ai-sdk/provider";
import { gateway, type LanguageModel, wrapLanguageModel } from "ai";

/**
 * Serves `model` so every call it starts gets an id no call in `taken` holds.
 *
 * Calls are keyed by the provider's tool call id, from the session's tables to the prompt's
 * tool results. Some providers number calls per response, so a later turn can repeat an id
 * the session already introduced; that call is renamed, with every part that refers to it, as
 * the stream arrives, so the model, the tables and readers all see the same new id. `taken`
 * holds the ids the session still holds: the calls in its view and the prompt's tool calls.
 * A call that left both, by retention and then a clear or compaction, can see its id again; the
 * session's own view no longer has it, and a reader of the whole stream keeps the earlier call.
 */
export function withUniqueCallIds(model: LanguageModel, taken: Iterable<string>): LanguageModel {
  return wrapLanguageModel({ model: resolved(model), middleware: uniqueCallIds(new Set(taken)) });
}

/**
 * A model named by a string, resolved as the AI SDK resolves it when it calls the model: through
 * `globalThis.AI_SDK_DEFAULT_PROVIDER` when one is set, otherwise the Gateway.
 */
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
  // The id each provider id currently stands for, and the calls whose input is still streaming.
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
          // A call whose input streamed was introduced at its start; any other is new here.
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
