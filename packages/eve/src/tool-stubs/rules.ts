import { z } from "#compiled/zod/index.js";
import { CALL_TOOL_NAME, SEARCH_TOOL_NAME, SKILL_TOOL_NAME } from "#protocol/catalog-tools.js";
import { parseJsonValue } from "#shared/json.js";
import { createStubValidator, validateStubConstraint } from "#tool-stubs/schema.js";
import type { ToolStub } from "#tool-stubs/types.js";

const ruleSchema = z.strictObject({
  id: z.string().min(1),
  tool: z.string().min(1),
  match: z.record(z.string(), z.union([z.boolean(), z.record(z.string(), z.json())])).optional(),
});

const outcomeSchema = z.union([
  z.strictObject({ response: z.json() }),
  z.strictObject({
    throw: z.strictObject({ message: z.string(), name: z.string().min(1).optional() }),
  }),
]);

const toolStubsSchema = z
  .array(
    z.union([
      ruleSchema.extend({ outcome: outcomeSchema }),
      ruleSchema.extend({ outcomes: z.tuple([outcomeSchema]).rest(outcomeSchema) }),
    ]),
  )
  .max(100);

/** Validates stubs before creating the session. */
export function parseToolStubs(value: unknown): readonly ToolStub[] {
  boundStubConfiguration(value);
  const rules = toolStubsSchema.parse(parseJsonValue(value));
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) throw new Error(`Duplicate tool stub id "${rule.id}".`);
    ids.add(rule.id);
    if (
      [SEARCH_TOOL_NAME, CALL_TOOL_NAME, SKILL_TOOL_NAME].includes(rule.tool.split("/").at(-1)!)
    ) {
      throw new Error(
        `Cannot stub ${SEARCH_TOOL_NAME}, ${CALL_TOOL_NAME}, or ${SKILL_TOOL_NAME}. Stub the tool an ${CALL_TOOL_NAME} call reaches, such as linear__list_issues.`,
      );
    }
    for (const [property, schema] of Object.entries(rule.match ?? {})) {
      validateStubConstraint(schema, rule.id, property);
      try {
        createStubValidator(schema);
      } catch (cause) {
        throw new Error(`Could not create matcher "${property}" in tool stub "${rule.id}".`, {
          cause,
        });
      }
    }
  }
  return rules;
}

function boundStubConfiguration(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  let size = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (++nodes > 20_000 || entry.depth > 32) {
      throw new Error("Tool stubs exceed the size or nesting limit.");
    }
    if (typeof entry.value === "string") size += entry.value.length;
    if (entry.value !== null && typeof entry.value === "object") {
      for (const [key, child] of Object.entries(entry.value)) {
        if (key === "__proto__") throw new Error("Tool stubs cannot contain prototype keys.");
        size += key.length;
        pending.push({ value: child, depth: entry.depth + 1 });
      }
    }
    if (size > 1_000_000) throw new Error("Tool stubs exceed the size or nesting limit.");
  }
}
