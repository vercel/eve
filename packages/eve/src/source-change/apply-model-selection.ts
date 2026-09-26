import {
  escapeForQuote,
  isAstNode,
  keyMatches,
  lineAt,
  parseAgentObject,
  unwrapExpression,
  type AstNode,
  type ObjectExpression,
  type Program,
} from "./agent-config-ast.js";
import { MODEL_HELPERS, parseModelHelper, type ModelHelper } from "#shared/model-helper.js";

type SourceEdit =
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

/** Reads only model expressions the source editor can safely rewrite. */
export async function readModelSelectionFromSource(
  sourceText: string,
): Promise<string | undefined> {
  const parsed = await parseAgentObject(sourceText);
  if (parsed.kind === "bail") return undefined;
  const value = findModelValue(parsed.object);
  return value === undefined ? undefined : currentSelection(value, parsed.program);
}

/** Rewrites between a Gateway string model and an eve-owned model helper. */
export async function applyModelSelectionToSource(
  sourceText: string,
  selection: string,
): Promise<SourceEdit> {
  const parsed = await parseAgentObject(sourceText);
  if (parsed.kind === "bail") return parsed;
  const value = findModelValue(parsed.object);
  if (value === undefined || value.start === undefined || value.end === undefined) {
    return {
      kind: "bail",
      reason: "`model` is absent or cannot be edited safely",
      line: lineAt(sourceText, parsed.object.start),
    };
  }

  const current = currentSelection(value, parsed.program);
  if (current === undefined) {
    return {
      kind: "bail",
      reason: "`model` is neither a string literal nor an eve model helper",
      line: lineAt(sourceText, value.start),
    };
  }

  const helperSelection = parseModelHelper(selection);
  if (helperSelection) {
    const helper = helperSelection.helper;
    const imported = hasHelperImport(parsed.program, helper);
    if (!imported && hasIdentifier(parsed.program, helper)) {
      return {
        kind: "bail",
        reason: `Cannot safely introduce the ${helper} import; that name is already used`,
        line: lineAt(sourceText, value.start),
      };
    }
  }
  const replacement =
    helperSelection !== undefined
      ? `${helperSelection.helper}(${JSON.stringify(helperSelection.id)})`
      : `${sourceText[value.start] === "'" ? "'" : '"'}${escapeForQuote(
          selection,
          sourceText[value.start] === "'" ? "'" : '"',
        )}${sourceText[value.start] === "'" ? "'" : '"'}`;
  let nextSource = sourceText.slice(0, value.start) + replacement + sourceText.slice(value.end);
  if (helperSelection !== undefined)
    nextSource = hasHelperImport(parsed.program, helperSelection.helper)
      ? nextSource
      : `import { ${helperSelection.helper} } from "${MODEL_HELPERS[helperSelection.helper].module}";\n${nextSource}`;
  const previous = parseModelHelper(current);
  if (previous && previous.helper !== helperSelection?.helper) {
    const withImport = await parseAgentObject(nextSource);
    const declaration =
      withImport.kind === "ok" ? helperImport(withImport.program, previous.helper) : undefined;
    const withoutImport =
      declaration?.start !== undefined && declaration.end !== undefined
        ? nextSource.slice(0, declaration.start) +
          removeHelperImport(
            nextSource.slice(declaration.start, declaration.end),
            previous.helper,
          ) +
          nextSource.slice(declaration.end)
        : nextSource;
    const parsedNext = await parseAgentObject(withoutImport);
    if (parsedNext.kind === "ok" && !hasIdentifier(parsedNext.program, previous.helper))
      nextSource = withoutImport;
  }
  return { kind: "applied", from: current, to: selection, nextSource };
}

function findModelValue(object: ObjectExpression): AstNode | undefined {
  for (const property of object.properties) {
    if (property.type !== "Property" || property.computed || !keyMatches(property.key, "model")) {
      continue;
    }
    return isAstNode(property.value) ? unwrapExpression(property.value) : undefined;
  }
  return undefined;
}

function currentSelection(value: AstNode, program: Program): string | undefined {
  if (value.type === "Literal" && typeof value.value === "string") return value.value;
  if (value.type !== "CallExpression" || !isAstNode(value.callee)) return undefined;
  const callee = unwrapExpression(value.callee);
  if (
    callee.type !== "Identifier" ||
    typeof callee.name !== "string" ||
    !(callee.name in MODEL_HELPERS)
  )
    return undefined;
  const helper = callee.name as ModelHelper;
  const spec = MODEL_HELPERS[helper];
  if (!hasHelperImport(program, helper)) return undefined;
  if ((value.arguments?.length ?? 0) > 1) return undefined;
  const argument = value.arguments?.[0];
  if (argument === undefined) return spec.prefix + spec.defaultModel;
  if (!isAstNode(argument)) return undefined;
  const unwrapped = unwrapExpression(argument);
  if (unwrapped.type !== "Literal" || typeof unwrapped.value !== "string") return undefined;
  const id = unwrapped.value
    .trim()
    .replace(new RegExp(`^${helper === "chatgpt" ? "openai" : helper}/`, "u"), "");
  return id && !id.includes("/") ? spec.prefix + id : undefined;
}

function helperImportPattern(helper: ModelHelper): RegExp {
  return new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*["']${MODEL_HELPERS[helper].module}["'];?`,
    "u",
  );
}

function removeHelperImport(source: string, helper: ModelHelper): string {
  return source.replace(helperImportPattern(helper), (full, contents: string) => {
    const names = contents
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const remaining = names.filter((name) => name !== helper);
    if (remaining.length === names.length) return full;
    return remaining.length === 0
      ? ""
      : `import { ${remaining.join(", ")} } from "${MODEL_HELPERS[helper].module}";`;
  });
}

function hasIdentifier(value: unknown, name: string): boolean {
  if (value === null || typeof value !== "object") return false;
  if (isAstNode(value) && value.type === "Identifier" && value.name === name) return true;
  return Object.values(value).some((child) => hasIdentifier(child, name));
}

function helperImport(program: Program, helper: ModelHelper): AstNode | undefined {
  return program.body?.find(
    (node) =>
      node.type === "ImportDeclaration" &&
      node.source?.value === MODEL_HELPERS[helper].module &&
      node.importKind !== "type" &&
      node.specifiers?.some(
        (specifier) =>
          specifier.imported?.name === helper &&
          specifier.local?.name === helper &&
          specifier.importKind !== "type",
      ),
  );
}
function hasHelperImport(program: Program, helper: ModelHelper): boolean {
  return helperImport(program, helper) !== undefined;
}
