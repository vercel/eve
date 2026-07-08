import { parseWithNitroRolldownAst } from "#internal/bundler/nitro-rolldown.js";

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

const AGENT_FACTORY = "defineAgent";

type Program = {
  readonly body?: readonly AstNode[];
};

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

type ObjectExpression = AstNode & {
  readonly properties: readonly AstNode[];
  readonly type: "ObjectExpression";
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
  const parsed = await parseAgentSource(sourceText);
  if ("kind" in parsed) {
    return parsed;
  }

  if ((parsed.errors?.length ?? 0) > 0) {
    const first = parsed.errors?.[0];
    return {
      kind: "bail",
      reason: `agent.ts does not parse: ${first?.message ?? "unknown parse error"}`,
      line: parseErrorLine(sourceText, first),
    };
  }

  const program = parsed.program ?? parsed;
  const object = findDefineAgentObject(program, AGENT_FACTORY);
  if (object === undefined) {
    return {
      kind: "bail",
      reason: `no \`export default ${AGENT_FACTORY}({ ... })\` call found`,
      line: 1,
    };
  }

  const literal = findStringLiteralProperty(object, "model");
  if (literal === undefined) {
    return {
      kind: "bail",
      reason:
        "`model` is absent or is not a string literal (e.g. an env reference, a template, an inlined SDK model, or a defineDynamic() dynamic model)",
      line: lineAt(sourceText, object.start ?? 0),
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

async function parseAgentSource(sourceText: string): Promise<ParsedSource | SourceEdit> {
  try {
    return (await parseWithNitroRolldownAst("agent.ts", sourceText)) as ParsedSource;
  } catch (error) {
    const parseError = error as ParseError;
    return {
      kind: "bail",
      reason: `agent.ts does not parse: ${parseError.message ?? "unknown parse error"}`,
      line: parseErrorLine(sourceText, parseError),
    };
  }
}

/** Strips `as`, `satisfies`, and parentheses to reach the underlying expression. */
function unwrapExpression(expression: AstNode): AstNode {
  let node: AstNode = expression;
  while (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression"
  ) {
    if (node.expression === undefined || node.expression === null) {
      return node;
    }
    node = node.expression;
  }
  return node;
}

/** Locates the object literal of a top-level `export default factory({ ... })`. */
function findDefineAgentObject(program: Program, factory: string): ObjectExpression | undefined {
  for (const statement of program.body ?? []) {
    if (statement.type !== "ExportDefaultDeclaration") {
      continue;
    }
    const declaration = statement.declaration;
    if (declaration === undefined || declaration === null) {
      continue;
    }
    if (
      declaration.type !== "CallExpression" &&
      declaration.type !== "ParenthesizedExpression" &&
      declaration.type !== "TSAsExpression" &&
      declaration.type !== "TSSatisfiesExpression"
    ) {
      continue;
    }
    const call = unwrapExpression(declaration);
    if (call.type !== "CallExpression" || !isFactoryCallee(call.callee, factory)) {
      continue;
    }
    const firstArgument = call.arguments?.[0];
    if (firstArgument === undefined || firstArgument.type === "SpreadElement") {
      continue;
    }
    const argument = unwrapExpression(firstArgument);
    if (argument.type === "ObjectExpression") {
      return argument as ObjectExpression;
    }
  }
  return undefined;
}

function isFactoryCallee(callee: AstNode | undefined, factory: string): boolean {
  return callee?.type === "Identifier" && callee.name === factory;
}

/**
 * Returns the string-literal value node for `key`, or undefined when the
 * property is missing, spread, computed, or resolves to a non-string value.
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

function keyMatches(key: AstNode | undefined, name: string): boolean {
  if (key === undefined) {
    return false;
  }
  if (key.type === "Identifier") {
    return key.name === name;
  }
  if (key.type === "Literal") {
    return typeof key.value === "string" && key.value === name;
  }
  return false;
}

function isAstNode(value: unknown): value is AstNode {
  return value !== null && typeof value === "object" && typeof (value as AstNode).type === "string";
}

function parseErrorLine(source: string, error: ParseError | undefined): number {
  if (typeof error?.loc?.line === "number") {
    return error.loc.line;
  }
  const offset = error?.labels?.[0]?.start ?? error?.start;
  return lineAt(source, offset ?? 0);
}

function escapeForQuote(value: string, quote: '"' | "'"): string {
  return value.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`);
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === "\n") {
      line += 1;
    }
  }
  return line;
}
