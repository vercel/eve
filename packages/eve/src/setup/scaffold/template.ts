import { SCAFFOLD_TEMPLATE_SOURCES, type ScaffoldTemplateId } from "./templates.js";

/** Values substituted into typed source-template placeholders. */
export interface SourceTemplateExpression {
  readonly source: string;
}

/** Marks a verified TypeScript expression for source-template substitution. */
export function sourceTemplateExpression(source: string): SourceTemplateExpression {
  return { source };
}

/** Values substituted into typed source-template placeholders. */
export type SourceTemplateValues = Readonly<
  Partial<Record<string, string | SourceTemplateExpression>>
>;

/** Renders a source template, safely quoting string substitutions. */
export function renderSourceTemplate(
  template: ScaffoldTemplateId,
  values: SourceTemplateValues = {},
): string {
  let source: string = SCAFFOLD_TEMPLATE_SOURCES[template];
  for (const [placeholder, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (!/^__EVE_[A-Z0-9_]+__$/.test(placeholder)) {
      throw new Error(`Invalid source-template placeholder ${JSON.stringify(placeholder)}.`);
    }
    source = source.replaceAll(
      placeholder,
      typeof value === "string" ? JSON.stringify(value) : value.source,
    );
  }

  const unresolved = source.match(/__EVE_[A-Z0-9_]+__/g);
  if (unresolved !== null) {
    throw new Error(`Missing source-template values: ${[...new Set(unresolved)].join(", ")}.`);
  }
  return source;
}
