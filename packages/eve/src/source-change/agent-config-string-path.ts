import { parseWithNitroRolldownAst } from "#internal/bundler/nitro-rolldown.js";

type Program = { readonly body?: readonly AstNode[] };

type AstNode = {
  readonly arguments?: readonly AstNode[];
  readonly callee?: AstNode;
  readonly computed?: boolean;
  readonly declaration?: AstNode | null;
  readonly end?: number;
  readonly expression?: AstNode | null;
  readonly key?: AstNode;
  readonly name?: string;
  readonly properties?: readonly AstNode[];
  readonly raw?: string;
  readonly start?: number;
  readonly type?: string;
  readonly value?: AstNode | string | number | boolean | null;
};

type ObjectExpression = AstNode & {
  readonly end: number;
  readonly properties: readonly AstNode[];
  readonly start: number;
  readonly type: "ObjectExpression";
};

type PropertyNode = AstNode & {
  readonly end: number;
  readonly start: number;
  readonly type: "Property";
};

type ParsedSource = Program & {
  readonly errors?: readonly ParseError[];
  readonly program?: Program;
};

type ParseError = {
  readonly labels?: readonly { readonly start?: number }[];
  readonly loc?: { readonly line?: number };
  readonly message?: string;
  readonly start?: number;
};

export type AgentConfigStringPathPatch =
  | { readonly kind: "set"; readonly value: string }
  | { readonly kind: "remove"; readonly removable?: (value: string) => boolean };

export type AgentConfigStringPathEdit =
  | { readonly kind: "applied"; readonly nextSource: string }
  | { readonly kind: "bail"; readonly reason: string; readonly line: number };

type ParsedAgentObject =
  | { readonly kind: "ok"; readonly object: ObjectExpression }
  | { readonly kind: "bail"; readonly reason: string; readonly line: number };

/** Safely applies one literal string leaf below `defineAgent({ ... })`. */
export async function applyAgentConfigStringPath(
  sourceText: string,
  path: readonly [string, ...string[]],
  patch: AgentConfigStringPathPatch,
): Promise<AgentConfigStringPathEdit> {
  const parsed = await parseAgentObject(sourceText);
  if (parsed.kind === "bail") return parsed;

  const objects: ObjectExpression[] = [parsed.object];
  const pathProperties: PropertyNode[] = [];
  let object = parsed.object;

  for (const [index, key] of path.slice(0, -1).entries()) {
    const found = findProperty(object, key);
    if (found.kind === "bail") return { ...found, line: lineAt(sourceText, object.start) };
    if (found.property === undefined) {
      if (patch.kind === "remove") return { kind: "applied", nextSource: sourceText };
      const value = nestedObjectSource(path.slice(index + 1), patch.value);
      return {
        kind: "applied",
        nextSource: insertProperty(sourceText, object, key, value),
      };
    }

    const value = propertyObjectValue(found.property);
    if (value === undefined) {
      return {
        kind: "bail",
        reason: `\`${key}\` is not an object literal that eve can edit safely`,
        line: lineAt(sourceText, found.property.start),
      };
    }
    pathProperties.push(found.property);
    objects.push(value);
    object = value;
  }

  const leaf = path.at(-1)!;
  const found = findProperty(object, leaf);
  if (found.kind === "bail") return { ...found, line: lineAt(sourceText, object.start) };

  if (found.property === undefined) {
    if (patch.kind === "remove") return { kind: "applied", nextSource: sourceText };
    return {
      kind: "applied",
      nextSource: insertProperty(sourceText, object, leaf, JSON.stringify(patch.value)),
    };
  }

  const current = propertyStringValue(found.property);
  if (current === undefined) {
    return {
      kind: "bail",
      reason: `\`${path.join(".")}\` is not a string literal that eve can edit safely`,
      line: lineAt(sourceText, found.property.start),
    };
  }

  if (patch.kind === "set") {
    if (current.value === patch.value) return { kind: "applied", nextSource: sourceText };
    const quote = current.raw?.[0] === "'" ? "'" : '"';
    const replacement = `${quote}${escapeForQuote(patch.value, quote)}${quote}`;
    return {
      kind: "applied",
      nextSource: sourceText.slice(0, current.start) + replacement + sourceText.slice(current.end),
    };
  }

  if (patch.removable !== undefined && !patch.removable(current.value)) {
    return {
      kind: "bail",
      reason: `\`${path.join(".")}\` has the custom value ${JSON.stringify(current.value)}`,
      line: lineAt(sourceText, found.property.start),
    };
  }

  let removalProperty = found.property;
  let containingObject = object;
  for (let index = objects.length - 1; index > 0; index -= 1) {
    if (containingObject.properties.length !== 1) break;
    removalProperty = pathProperties[index - 1]!;
    containingObject = objects[index - 1]!;
  }
  return {
    kind: "applied",
    nextSource: removeProperty(sourceText, containingObject, removalProperty),
  };
}

/**
 * The write-guard invariant: an edited source must still parse and still
 * carry the `defineAgent({ ... })` object. Returns the failure reason, or
 * undefined when the source is sound. Callers bail instead of writing, so an
 * editor bug degrades to a "change it by hand" message rather than a broken
 * agent.ts.
 */
export async function checkAgentConfigSource(sourceText: string): Promise<string | undefined> {
  const parsed = await parseAgentObject(sourceText);
  return parsed.kind === "bail" ? parsed.reason : undefined;
}

async function parseAgentObject(sourceText: string): Promise<ParsedAgentObject> {
  let parsed: ParsedSource;
  try {
    parsed = (await parseWithNitroRolldownAst("agent.ts", sourceText)) as ParsedSource;
  } catch (error) {
    const parseError = error as ParseError;
    return {
      kind: "bail",
      reason: `agent.ts does not parse: ${parseError.message ?? "unknown parse error"}`,
      line: parseErrorLine(sourceText, parseError),
    };
  }

  if ((parsed.errors?.length ?? 0) > 0) {
    const first = parsed.errors?.[0];
    return {
      kind: "bail",
      reason: `agent.ts does not parse: ${first?.message ?? "unknown parse error"}`,
      line: parseErrorLine(sourceText, first),
    };
  }

  const object = findDefineAgentObject(parsed.program ?? parsed);
  return object === undefined
    ? { kind: "bail", reason: "no `export default defineAgent({ ... })` call found", line: 1 }
    : { kind: "ok", object };
}

function findDefineAgentObject(program: Program): ObjectExpression | undefined {
  for (const statement of program.body ?? []) {
    if (statement.type !== "ExportDefaultDeclaration" || statement.declaration == null) continue;
    const call = unwrapExpression(statement.declaration);
    if (
      call.type !== "CallExpression" ||
      call.callee?.type !== "Identifier" ||
      call.callee.name !== "defineAgent"
    ) {
      continue;
    }
    const argument = call.arguments?.[0];
    if (argument === undefined || argument.type === "SpreadElement") continue;
    const object = unwrapExpression(argument);
    if (
      object.type === "ObjectExpression" &&
      object.start !== undefined &&
      object.end !== undefined &&
      object.properties !== undefined
    ) {
      return object as ObjectExpression;
    }
  }
  return undefined;
}

function findProperty(
  object: ObjectExpression,
  key: string,
):
  | { readonly kind: "ok"; readonly property?: PropertyNode }
  | { readonly kind: "bail"; readonly reason: string } {
  if (
    object.properties.some(
      (property) => property.type === "SpreadElement" || property.computed === true,
    )
  ) {
    return { kind: "bail", reason: `\`${key}\` may be supplied by a spread or computed property` };
  }
  const matches = object.properties.filter(
    (property) =>
      property.type === "Property" && !property.computed && keyMatches(property.key, key),
  );
  if (matches.length > 1) return { kind: "bail", reason: `\`${key}\` is defined more than once` };
  const match = matches[0];
  if (match !== undefined && match.start !== undefined && match.end !== undefined) {
    return { kind: "ok", property: match as PropertyNode };
  }
  return { kind: "ok" };
}

function propertyObjectValue(property: PropertyNode): ObjectExpression | undefined {
  const raw = property.value;
  if (!isAstNode(raw)) return undefined;
  const value = unwrapExpression(raw);
  return value.type === "ObjectExpression" &&
    value.start !== undefined &&
    value.end !== undefined &&
    value.properties !== undefined
    ? (value as ObjectExpression)
    : undefined;
}

function propertyStringValue(
  property: PropertyNode,
):
  | { readonly start: number; readonly end: number; readonly value: string; readonly raw?: string }
  | undefined {
  const raw = property.value;
  if (!isAstNode(raw)) return undefined;
  const value = unwrapExpression(raw);
  if (
    value.type !== "Literal" ||
    typeof value.value !== "string" ||
    value.start === undefined ||
    value.end === undefined
  ) {
    return undefined;
  }
  const literal = {
    start: value.start,
    end: value.end,
    value: value.value,
  };
  return value.raw === undefined ? literal : { ...literal, raw: value.raw };
}

function nestedObjectSource(path: readonly string[], value: string): string {
  let result = JSON.stringify(value);
  for (const key of [...path].reverse()) result = `{ ${key}: ${result} }`;
  return result;
}

function insertProperty(
  source: string,
  object: ObjectExpression,
  key: string,
  valueSource: string,
): string {
  const closeBrace = object.end - 1;
  const last = object.properties.at(-1);
  if (last === undefined || last.end === undefined) {
    return source.slice(0, closeBrace) + ` ${key}: ${valueSource} ` + source.slice(closeBrace);
  }

  const closingLineStart = source.lastIndexOf("\n", closeBrace - 1) + 1;
  if (closingLineStart > object.start) {
    const closeIndent = source.slice(closingLineStart, closeBrace);
    const propertyIndent = `${closeIndent}  `;
    const gap = source.slice(last.end, closingLineStart);
    let next = source;
    if (!gap.includes(",")) next = next.slice(0, last.end) + "," + next.slice(last.end);
    const adjustedLineStart = closingLineStart + (gap.includes(",") ? 0 : 1);
    return (
      next.slice(0, adjustedLineStart) +
      `${propertyIndent}${key}: ${valueSource},\n` +
      next.slice(adjustedLineStart)
    );
  }

  const gap = source.slice(last.end, closeBrace);
  const separator = gap.includes(",") ? " " : ", ";
  return (
    source.slice(0, closeBrace) + `${separator}${key}: ${valueSource}` + source.slice(closeBrace)
  );
}

function removeProperty(source: string, object: ObjectExpression, property: PropertyNode): string {
  const index = object.properties.indexOf(property);
  const previous = index > 0 ? object.properties[index - 1] : undefined;
  const next = index >= 0 ? object.properties[index + 1] : undefined;
  if (next?.start !== undefined) return source.slice(0, property.start) + source.slice(next.start);
  if (previous?.end !== undefined) {
    // The text after the removed span (a trailing comma, whitespace) becomes
    // the previous property's trailer, which stays valid.
    return source.slice(0, previous.end) + source.slice(property.end);
  }
  // Sole property: empty the braces outright. Slicing out only the property
  // would leave its trailing comma behind (`{ , }`), which does not parse.
  return source.slice(0, object.start + 1) + source.slice(object.end - 1);
}

function unwrapExpression(expression: AstNode): AstNode {
  let node = expression;
  while (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression"
  ) {
    if (node.expression == null) return node;
    node = node.expression;
  }
  return node;
}

function keyMatches(key: AstNode | undefined, name: string): boolean {
  if (key?.type === "Identifier") return key.name === name;
  return key?.type === "Literal" && typeof key.value === "string" && key.value === name;
}

function isAstNode(value: unknown): value is AstNode {
  return value !== null && typeof value === "object" && typeof (value as AstNode).type === "string";
}

function parseErrorLine(source: string, error: ParseError | undefined): number {
  if (typeof error?.loc?.line === "number") return error.loc.line;
  return lineAt(source, error?.labels?.[0]?.start ?? error?.start ?? 0);
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function escapeForQuote(value: string, quote: '"' | "'"): string {
  return value.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`);
}
