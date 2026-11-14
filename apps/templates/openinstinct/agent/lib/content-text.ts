import type { JsonValue, UserPart } from "eve/events";
import { z } from "zod";

/** The text of a delivered message, without its file parts. */
export function deliveredText(parts: readonly UserPart[]) {
  return parts
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("\n");
}

/** The text of recorded content parts, skipping non-text values. */
export function contentText(
  parts: readonly { readonly value?: JsonValue }[],
  separator = "\n\n"
) {
  return parts
    .flatMap(({ value }) => {
      const text = z.string().safeParse(value);
      return text.success ? [text.data] : [];
    })
    .join(separator);
}
