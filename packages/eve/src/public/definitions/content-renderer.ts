import type { CardElement } from "#public/channels/slack/cards.js";

/** What a content renderer knows about the value it renders. */
export interface ContentRendererContext {
  /**
   * `true` while the model is still writing the part. `value` is then the partial JSON parsed so
   * far, for a `+json` media type, and may be missing fields the finished part has.
   */
  readonly partial: boolean;
}

/**
 * Renders reply parts of one media type, such as a tool's card, in channels that support rich
 * messages. A channel that can't use the renderer, or a renderer that returns `null` or throws,
 * shows the part's `fallbackText`.
 */
export interface ContentRendererDefinition {
  /** The media type of the parts this renderer draws, such as `"application/vnd.acme.card+json"`. */
  readonly mediaType: string;
  /**
   * Returns a card for channels with rich messages, such as Slack and Chat SDK adapters, or `null`
   * to show the part's fallback text. Runs for each preview while the part streams, and again
   * when it completes.
   */
  card?(value: unknown, ctx: ContentRendererContext): CardElement | null;
  /** Returns markdown for channels that post markdown, such as GitHub and Linear, or `null`. */
  markdown?(value: unknown): string | null;
}

/**
 * Defines a content renderer. Export it from `agent/renderers/<name>.ts`, or from an extension's
 * `extension/renderers/<name>.ts`:
 *
 * ```ts
 * import { Card, CardText } from "eve/cards";
 * import { defineContentRenderer } from "eve/renderers";
 *
 * export default defineContentRenderer({
 *   mediaType: "application/vnd.acme.card+json",
 *   card(value) {
 *     const { title, body } = value as { title: string; body: string };
 *     return Card({ title, children: [CardText(body)] });
 *   },
 * });
 * ```
 */
export function defineContentRenderer(
  definition: ContentRendererDefinition,
): ContentRendererDefinition {
  assertContentRendererForm(definition, "defineContentRenderer()");
  return definition;
}

/**
 * Throws unless `value` is a content renderer: an object with a `mediaType` and at least one of
 * `card` and `markdown`. The definer, the compiler, and the runtime loader all use it.
 */
export function assertContentRendererForm(
  value: unknown,
  subject: string,
): asserts value is ContentRendererDefinition {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${subject} takes an object with a mediaType and a card or markdown function.`);
  }
  const { card, markdown, mediaType, ...rest } = value as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length > 0) {
    throw new Error(
      `${subject} takes only mediaType, card, and markdown; unknown key(s): ${extra.join(", ")}.`,
    );
  }
  if (typeof mediaType !== "string" || mediaType.length === 0) {
    throw new Error(`${subject} requires mediaType, such as "application/vnd.acme.card+json".`);
  }
  for (const [key, fn] of Object.entries({ card, markdown })) {
    if (fn !== undefined && typeof fn !== "function") {
      throw new Error(`${subject} requires ${key} to be a function.`);
    }
  }
  if (card === undefined && markdown === undefined) {
    throw new Error(`${subject} requires a card or markdown function.`);
  }
}
