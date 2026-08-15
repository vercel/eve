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

/**
 * Outcome of a source-to-source edit attempt. Pure data. On success it carries
 * the rewritten source, so the caller owns the filesystem write.
 */
export type SourceEdit =
  | {
      readonly kind: "applied";
      readonly from: string;
      readonly to: string;
      readonly nextSource: string;
    }
  | {
      readonly kind: "bail";
      readonly reason: string;
      readonly line: number;
    };

type StringLiteral = AstNode & {
  readonly end: number;
  readonly start: number;
  readonly value: string;
};

/**
 * Rewrites the `model` string literal passed to `defineAgent({ ... })` in
 * `sourceText`, returning the edited source.
 *
 * Pure transform: parses with Rolldown, finds the literal's byte span, and splices
 * only those bytes, so comments, formatting, and quote style everywhere else
 * are preserved by construction. Bails (no edit) when `model` is absent or
 * isn't a plain string literal. An env reference, a template, an inlined SDK
 * model object, or a spread all opt out into the manual path instead.
 */
export async function applyModelNameToSource(
  sourceText: string,
  modelName: string,
): Promise<SourceEdit> {
  const parsed = await parseAgentObject(sourceText);
  if (parsed.kind === "bail") return parsed;
  const object = parsed.object;

  const literal = findStringLiteralProperty(object, "model");
  if (literal === undefined) {
    return {
      kind: "bail",
      reason:
        "`model` is absent or is not a string literal (e.g. an env reference, a template, an inlined SDK model, or a defineDynamic() dynamic model)",
      line: lineAt(sourceText, object.start),
    };
  }

  const from = literal.value;
  if (from === modelName) {
    return { kind: "applied", from, to: modelName, nextSource: sourceText };
  }

  const quote = literal.raw?.[0] === "'" ? "'" : '"';
  const replacement = `${quote}${escapeForQuote(modelName, quote)}${quote}`;
  const nextSource =
    sourceText.slice(0, literal.start) + replacement + sourceText.slice(literal.end);

  return { kind: "applied", from, to: modelName, nextSource };
}

/**
 * Returns the string-literal value node for `key`, or undefined when the
 * property is missing, spread, computed, or resolves to a non-string value.
 * Deliberately more permissive than the path editor's lookup: a spread
 * elsewhere in the object does not block rewriting an explicit `model`
 * literal, matching the original `/model <slug>` contract.
 */
function findStringLiteralProperty(
  object: ObjectExpression,
  key: string,
): StringLiteral | undefined {
  for (const property of object.properties) {
    if (property.type !== "Property" || property.computed || !keyMatches(property.key, key)) {
      continue;
    }
    const rawValue = property.value;
    if (!isAstNode(rawValue)) {
      continue;
    }
    const value = unwrapExpression(rawValue);
    // All literal kinds share `type: "Literal"`; the typeof guard selects strings.
    if (
      value.type === "Literal" &&
      typeof value.value === "string" &&
      value.start !== undefined &&
      value.end !== undefined
    ) {
      return value as StringLiteral;
    }
    return undefined;
  }
  return undefined;
}
