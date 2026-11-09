/**
 * Content renderer authoring helpers for `agent/renderers/*.ts` files.
 *
 * A content renderer draws reply parts of one media type, such as a card a tool adds with
 * `replyPart`, natively in the channels that support rich messages.
 */

export {
  type ContentRendererContext,
  type ContentRendererDefinition,
  defineContentRenderer,
} from "#public/definitions/content-renderer.js";
