import {
  escapeForQuote,
  isAstNode,
  keyMatches,
  lineAt,
  parseAgentObject,
  unwrapExpression,
  type AstNode,
  type ObjectExpression,
} from "./agent-config-ast.js";

export { checkAgentConfigSource } from "./agent-config-ast.js";

type PropertyNode = AstNode & {
  readonly end: number;
  readonly start: number;
  readonly type: "Property";
};

export type AgentConfigStringPathPatch =
  | { readonly kind: "set"; readonly value: string }
  | { readonly kind: "remove"; readonly removable?: (value: string) => boolean };

export type AgentConfigStringPathEdit =
  | { readonly kind: "applied"; readonly nextSource: string }
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
