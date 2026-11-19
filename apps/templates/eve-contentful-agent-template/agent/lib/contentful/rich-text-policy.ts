import { z } from "zod";

import { configuredSpaces } from "./config";
import { pageKindInSpace, QUERY_SPACES } from "./model";
/* RichText edits are validated against the live content model and block hashes. */
/**
 * Space, content type, and operation used to enforce deployment-specific rich-text write policy.
 */
export interface FieldWriteContext {
  contentTypeId: string;
  operation?: "create" | "update";
  space: string;
}

/**
 * Enforces configured restrictions on replacing or clearing an entire rich-text field.
 *
 * @param context - Target space, content type, and whether this is initial creation.
 * @param field - Live field definition used to distinguish rich text from other values.
 * @param operation - Requested mutation; targeted patches bypass whole-body restrictions.
 * @throws {@link Error} When a protected rich-text field is replaced or cleared.
 * @remarks Initial page creation may supply a complete body; later edits can use hash-bound patches.
 */
export const assertRichTextWritable = (
  context: FieldWriteContext,
  field: { id: string; type: string },
  operation: "patch" | "set" | "unset" = "set"
) => {
  if (
    field.type !== "RichText" ||
    operation === "patch" ||
    (context.operation === "create" &&
      pageKindInSpace(QUERY_SPACES[context.space], context.contentTypeId) !==
        null)
  ) {
    return;
  }
  const protectedFields = z
    .array(z.string())
    .parse(JSON.parse(process.env.CONTENTFUL_PROTECTED_FIELDS || "[]"));
  const spaces = configuredSpaces();
  if (
    protectedFields.some((rule) => {
      const [space, contentTypeId, fieldId] = rule.split("/");
      return (
        (spaces[space] ?? space) === spaces[context.space] &&
        contentTypeId === context.contentTypeId &&
        fieldId === field.id
      );
    })
  ) {
    throw new Error(
      `RichText writes are not supported for ${context.space}/${context.contentTypeId}/${field.id}. Edit this body with operation=patch.`
    );
  }
};
