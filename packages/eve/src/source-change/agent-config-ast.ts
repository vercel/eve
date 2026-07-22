import { parseWithNitroRolldownAst } from "#internal/bundler/nitro-rolldown.js";

/**
 * The AST plumbing shared by the agent-config source editors: the loose
 * Rolldown node shapes, the parse-and-locate-`defineAgent({ ... })` pipeline,
 * and the string-splicing helpers. Editors own their edit policies; this
 * module owns how an agent config is read.
 */

export type Program = { readonly body?: readonly AstNode[] };

export type AstNode = {
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

export type ObjectExpression = AstNode & {
  readonly end: number;
  readonly properties: readonly AstNode[];
  readonly start: number;
  readonly type: "ObjectExpression";
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

export type ParsedAgentObject =
  | { readonly kind: "ok"; readonly object: ObjectExpression }
  | { readonly kind: "bail"; readonly reason: string; readonly line: number };

/** Parses a source and locates the `export default defineAgent({ ... })` object. */
export async function parseAgentObject(sourceText: string): Promise<ParsedAgentObject> {
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

/** Strips `as`, `satisfies`, and parentheses to reach the underlying expression. */
export function unwrapExpression(expression: AstNode): AstNode {
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

export function keyMatches(key: AstNode | undefined, name: string): boolean {
  if (key?.type === "Identifier") return key.name === name;
  return key?.type === "Literal" && typeof key.value === "string" && key.value === name;
}

export function isAstNode(value: unknown): value is AstNode {
  return value !== null && typeof value === "object" && typeof (value as AstNode).type === "string";
}

export function escapeForQuote(value: string, quote: '"' | "'"): string {
  return value.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`);
}

export function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function parseErrorLine(source: string, error: ParseError | undefined): number {
  if (typeof error?.loc?.line === "number") return error.loc.line;
  return lineAt(source, error?.labels?.[0]?.start ?? error?.start ?? 0);
}
