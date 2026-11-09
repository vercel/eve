// The schemas for every fact and progress type, for tests and development. Readers never load
// this module: they rely on the catalog and tolerate what they don't know.

import { z } from "#compiled/zod/index.js";

import type { FactType, ProgressType } from "./catalog.js";
import { callProgressSchemas, callSchemas } from "./families/call.js";
import { childSchemas } from "./families/child.js";
import { contentProgressSchemas, contentSchemas } from "./families/content.js";
import { contextSchemas } from "./families/context.js";
import { deliverySchemas } from "./families/delivery.js";
import { interactionSchemas } from "./families/interaction.js";
import { modelSchemas } from "./families/model.js";
import { responseSchemas } from "./families/response.js";
import { sessionSchemas } from "./families/session.js";
import { taskSchemas } from "./families/task.js";
import { turnSchemas } from "./families/turn.js";
import { usageSchemas } from "./families/usage.js";

export const FACT_SCHEMAS = {
  ...sessionSchemas,
  ...deliverySchemas,
  ...turnSchemas,
  ...modelSchemas,
  ...contentSchemas,
  ...callSchemas,
  ...taskSchemas,
  ...interactionSchemas,
  ...responseSchemas,
  ...childSchemas,
  ...contextSchemas,
  ...usageSchemas,
} satisfies { readonly [TType in FactType]: z.ZodType };

export const PROGRESS_SCHEMAS = {
  ...contentProgressSchemas,
  ...callProgressSchemas,
} satisfies { readonly [TType in ProgressType]: z.ZodType };

/**
 * Checks one fact or progress record of a known type against its schema, and returns what's
 * wrong, or `undefined`. Records of unknown types pass: readers ignore them.
 */
export function schemaViolation(record: unknown, kind: "fact" | "progress"): string | undefined {
  const type =
    record !== null && typeof record === "object"
      ? (record as { readonly type?: unknown }).type
      : undefined;
  if (typeof type !== "string") return `A ${kind} has no type.`;
  const schemas: Readonly<Record<string, z.ZodType>> =
    kind === "fact" ? FACT_SCHEMAS : PROGRESS_SCHEMAS;
  const schema = schemas[type];
  if (schema === undefined) return undefined;
  const parsed = schema.safeParse(record);
  return parsed.success ? undefined : `${type}: ${z.prettifyError(parsed.error)}`;
}
