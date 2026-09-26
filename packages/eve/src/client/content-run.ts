export interface ContentRun {
  readonly text: string;
  readonly status: "streaming" | "done";
}

/** A completed run under the same turn/step key is a different message. */
export function selectContentRun(
  latest: ContentRun | undefined,
  event:
    | { readonly type: "append"; readonly delta: string }
    | { readonly type: "complete"; readonly text: string | null },
): "ignore" | "new" | "current" {
  if (event.type === "append" && event.delta.length === 0) return "ignore";
  if (event.type === "complete" && event.text === null && latest?.status !== "streaming")
    return "ignore";
  return latest?.status === "streaming" ? "current" : "new";
}

export type ContentRunTransition =
  | { readonly type: "ignore" }
  | { readonly type: "remove" }
  | {
      readonly type: "update";
      readonly run: ContentRun;
      /** New text for append-only consumers; empty on replacement. */
      readonly delta: string;
      readonly replaced: boolean;
    };

/** Reduces content within one identified text or reasoning run. Identity is resolved by the caller. */
export function reduceContentRun(
  current: ContentRun | undefined,
  event:
    | { readonly type: "append"; readonly delta: string }
    | { readonly type: "complete"; readonly text: string | null },
): ContentRunTransition {
  if (event.type === "append") {
    if (event.delta.length === 0) return { type: "ignore" };
    return {
      type: "update",
      run: { text: (current?.text ?? "") + event.delta, status: "streaming" },
      delta: event.delta,
      replaced: false,
    };
  }
  if (event.text === null) return { type: "remove" };
  const streamed = current?.text ?? "";
  return {
    type: "update",
    run: { text: event.text, status: "done" },
    delta: event.text.startsWith(streamed) ? event.text.slice(streamed.length) : "",
    replaced: streamed.length > 0 && !event.text.startsWith(streamed),
  };
}
